/**
 * Shared shape + validation for a bulk queue DAG. Used by the `wb queue create`
 * CLI (client-side fast-fail) and the daemon endpoint that creates the DAG in one
 * transaction — one validator, no drift.
 */

/** One task in a bulk queue spec. `key` is a local alias other tasks depend on. */
export interface QueueSpecTask {
  key: string;
  title: string;
  request: string;
  dependsOn?: string | string[];
  priority?: number;
}
export interface QueueSpec {
  projectId: string;
  tasks: QueueSpecTask[];
}

/** Normalize a spec task's dependsOn to a string[] of keys. */
export function specDeps(t: QueueSpecTask): string[] {
  if (t.dependsOn == null) return [];
  return Array.isArray(t.dependsOn) ? t.dependsOn : [t.dependsOn];
}

/**
 * Validate a bulk queue spec WITHOUT touching a store or the network: shape,
 * unique keys, every dependsOn resolves to a sibling key, and the DAG is acyclic.
 * Returns the task keys in a topological order (dependencies first). THROWS on any
 * problem so a bad spec never leads to a half-built DAG.
 */
export function planQueueSpec(spec: QueueSpec): string[] {
  if (!spec || typeof spec.projectId !== 'string' || !spec.projectId) {
    throw new Error('spec.projectId is required');
  }
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) {
    throw new Error('spec.tasks must be a non-empty array');
  }
  const byKey = new Map<string, QueueSpecTask>();
  for (const t of spec.tasks) {
    if (!t.key || typeof t.key !== 'string') throw new Error('every task needs a string "key"');
    if (!t.title || !t.request) throw new Error(`task "${t.key}" needs a title and a request`);
    if (byKey.has(t.key)) throw new Error(`duplicate task key: "${t.key}"`);
    byKey.set(t.key, t);
  }
  for (const t of spec.tasks) {
    for (const dep of specDeps(t)) {
      if (!byKey.has(dep)) throw new Error(`task "${t.key}" dependsOn unknown key "${dep}"`);
      if (dep === t.key) throw new Error(`task "${t.key}" cannot depend on itself`);
    }
  }

  // Topological sort (Kahn) — surfaces both the run order and any cycle.
  const order: string[] = [];
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep-key -> keys that depend on it
  for (const t of spec.tasks) indegree.set(t.key, 0);
  for (const t of spec.tasks) {
    for (const dep of specDeps(t)) {
      indegree.set(t.key, (indegree.get(t.key) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), t.key]);
    }
  }
  const ready = [...indegree.entries()].filter(([, n]) => n === 0).map(([k]) => k);
  while (ready.length > 0) {
    const k = ready.shift() as string;
    order.push(k);
    for (const child of dependents.get(k) ?? []) {
      const n = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, n);
      if (n === 0) ready.push(child);
    }
  }
  if (order.length !== spec.tasks.length) {
    throw new Error('spec has a dependency cycle — cannot order the tasks');
  }
  return order;
}
