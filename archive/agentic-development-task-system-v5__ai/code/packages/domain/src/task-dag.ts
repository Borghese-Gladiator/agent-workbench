import { z } from 'zod';

/**
 * Per-edge dependency semantics (TASK-102):
 *  - 'stack' = git-base stacking: the child branches off — and its PR opens against — the parent's
 *    delivered branch. A node may have AT MOST ONE 'stack' parent (a branch has one base).
 *  - 'after' = scheduling-only fan-in: the child must not START until the predecessor releases, but
 *    it does NOT stack on it. A node may have MANY 'after' parents (fan-in / diamond).
 */
export type TaskDagEdgeMode = 'stack' | 'after';

/** One parent reference plus its mode. */
export const TaskDagEdgeSchema = z.object({
  ref: z.string().min(1),
  mode: z.enum(['stack', 'after']),
});
export type TaskDagEdge = z.infer<typeof TaskDagEdgeSchema>;

/**
 * `dependsOn` accepts, for back-compat, either:
 *  - a legacy scalar key string → normalized to a single 'stack' edge, or
 *  - an array of `{ ref, mode? }` where mode defaults to 'stack'.
 * After preprocessing it is always a `TaskDagEdge[]`.
 */
const DependsOnSchema = z.preprocess(
  (raw) => {
    if (raw === undefined) return undefined;
    if (typeof raw === 'string') return [{ ref: raw, mode: 'stack' }];
    if (Array.isArray(raw)) {
      return raw.map((e) =>
        typeof e === 'string'
          ? { ref: e, mode: 'stack' }
          : { ref: (e as { ref?: unknown }).ref, mode: (e as { mode?: unknown }).mode ?? 'stack' },
      );
    }
    return raw;
  },
  z.array(TaskDagEdgeSchema).optional(),
);

/**
 * One node in a declared stacked-PR task DAG. `key` is a caller-local id used only to wire edges
 * within this spec (not the persisted task id). `dependsOn` carries typed parent edges: at most one
 * 'stack' edge (the git base) plus any number of 'after' edges (scheduling-only fan-in).
 */
export const TaskDagNodeSchema = z.object({
  key: z.string().min(1),
  prompt: z.string().min(1),
  dependsOn: DependsOnSchema,
});
export type TaskDagNode = z.infer<typeof TaskDagNodeSchema>;

export const TaskDagSpecSchema = z.object({
  repositoryId: z.string().min(1),
  nodes: z.array(TaskDagNodeSchema).min(1),
});
export type TaskDagSpec = z.infer<typeof TaskDagSpecSchema>;

export class TaskDagValidationError extends Error {}

/**
 * Validate a stacked-PR task DAG spec WITHOUT touching a store: unique keys, every edge `ref`
 * resolves to a sibling key, no self-edge, at most one 'stack' parent per node, no cycle. Returns
 * the node keys in a topological order (parents before children) so the caller can create rows
 * parent-first. THROWS `TaskDagValidationError` on any problem so a bad spec never yields a
 * half-built DAG.
 *
 * In-degree is now the total number of parent edges (both 'stack' and 'after'), so a fan-in node
 * (e.g. a diamond: D after B and C, both after A) is a first-class shape. The single restriction on
 * fan-in is that at most ONE parent edge may be 'stack' — 'after' parents contribute ordering only.
 */
export function validateTaskDag(spec: TaskDagSpec): string[] {
  const { nodes } = spec;

  const keys = new Set<string>();
  for (const n of nodes) {
    if (keys.has(n.key)) throw new TaskDagValidationError(`duplicate node key "${n.key}"`);
    keys.add(n.key);
  }

  const edgesOf = new Map<string, TaskDagEdge[]>();
  for (const n of nodes) {
    const edges = n.dependsOn ?? [];
    let stackCount = 0;
    for (const edge of edges) {
      if (edge.ref === n.key) throw new TaskDagValidationError(`node "${n.key}" depends on itself`);
      if (!keys.has(edge.ref)) {
        throw new TaskDagValidationError(`node "${n.key}" depends on unknown key "${edge.ref}"`);
      }
      if (edge.mode === 'stack') stackCount += 1;
    }
    if (stackCount > 1) {
      throw new TaskDagValidationError(
        `node "${n.key}" has ${stackCount} 'stack' parents; a node may stack on at most one base branch`,
      );
    }
    edgesOf.set(n.key, edges);
  }

  // Topological order via Kahn's algorithm. In-degree is the count of parent edges (may be > 1 for a
  // fan-in node). A leftover node after the sweep means it sits on a cycle.
  const childrenOf = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const key of keys) {
    indegree.set(key, 0);
    childrenOf.set(key, []);
  }
  for (const [key, edges] of edgesOf) {
    indegree.set(key, edges.length);
    for (const edge of edges) {
      childrenOf.get(edge.ref)!.push(key);
    }
  }

  const queue = [...keys].filter((k) => indegree.get(k) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    for (const child of childrenOf.get(key)!) {
      const d = indegree.get(child)! - 1;
      indegree.set(child, d);
      if (d === 0) queue.push(child);
    }
  }

  if (order.length !== keys.size) {
    const onCycle = [...keys].filter((k) => !order.includes(k));
    throw new TaskDagValidationError(`task DAG has a cycle involving: ${onCycle.join(', ')}`);
  }

  return order;
}
