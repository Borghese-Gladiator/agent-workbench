/**
 * Must match `workers/temporal-worker/src/index.ts`'s `TASK_QUEUE`. Duplicated rather than
 * imported because the daemon and worker are separate processes/packages by design (the daemon
 * is a Temporal client, never a worker) — see docs/design.md's architecture section.
 */
export const TASK_QUEUE = 'awb-task-queue';
