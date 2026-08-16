import { z } from 'zod';

/**
 * One node in a declared stacked-PR task DAG. `key` is a caller-local id used only to wire edges
 * within this spec (not the persisted task id). `dependsOn` names the parent node's key — at most
 * ONE, because stacking derives a git branch from exactly one base ref (a node cannot stack on two
 * parents). Fan-out (many children sharing one parent) is fine; fan-in is rejected below.
 */
export const TaskDagNodeSchema = z.object({
  key: z.string().min(1),
  prompt: z.string().min(1),
  dependsOn: z.string().min(1).optional(),
});
export type TaskDagNode = z.infer<typeof TaskDagNodeSchema>;

export const TaskDagSpecSchema = z.object({
  repositoryId: z.string().min(1),
  nodes: z.array(TaskDagNodeSchema).min(1),
});
export type TaskDagSpec = z.infer<typeof TaskDagSpecSchema>;

export class TaskDagValidationError extends Error {}

/**
 * Validate a stacked-PR task DAG spec WITHOUT touching a store: unique keys, every `dependsOn`
 * resolves to a sibling key, no self-edge, no cycle. Returns the node keys in a topological order
 * (parents before children) so the caller can create rows parent-first. THROWS
 * `TaskDagValidationError` on any problem so a bad spec never yields a half-built DAG.
 *
 * Because each node stacks on at most one parent, the "graph" is a forest of stacking chains;
 * validation is a straightforward parent-pointer walk. (Fan-in is structurally impossible here —
 * a node has a single `dependsOn` — so there is nothing to reject beyond cycles/dangling refs.)
 */
export function validateTaskDag(spec: TaskDagSpec): string[] {
  const { nodes } = spec;

  const keys = new Set<string>();
  for (const n of nodes) {
    if (keys.has(n.key)) throw new TaskDagValidationError(`duplicate node key "${n.key}"`);
    keys.add(n.key);
  }

  const parentOf = new Map<string, string | undefined>();
  for (const n of nodes) {
    if (n.dependsOn !== undefined) {
      if (n.dependsOn === n.key) throw new TaskDagValidationError(`node "${n.key}" depends on itself`);
      if (!keys.has(n.dependsOn)) {
        throw new TaskDagValidationError(`node "${n.key}" depends on unknown key "${n.dependsOn}"`);
      }
    }
    parentOf.set(n.key, n.dependsOn);
  }

  // Topological order via Kahn's algorithm. In-degree here is 0 or 1 (single parent). A leftover
  // node after the sweep means it sits on a cycle.
  const childrenOf = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const key of keys) {
    indegree.set(key, 0);
    childrenOf.set(key, []);
  }
  for (const [key, parent] of parentOf) {
    if (parent !== undefined) {
      indegree.set(key, 1);
      childrenOf.get(parent)!.push(key);
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
