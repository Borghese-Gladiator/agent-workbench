import { resolveRuntimeConfig } from '@awb/config';

/**
 * The Temporal task queue the daemon submits workflows to. Resolved from the shared runtime config
 * (env-driven, `awb-task-queue` default) so an isolated stack's daemon enqueues onto ITS worker's
 * queue, never a sibling worktree's worker running different code. Must resolve to the same value as
 * `workers/temporal-worker/src/index.ts`'s `taskQueueName()` — both read the same config seam rather
 * than importing across the process/package boundary (the daemon is a Temporal client, never a
 * worker; see docs/design.md).
 */
export function taskQueueName(): string {
  return resolveRuntimeConfig().taskQueue;
}
