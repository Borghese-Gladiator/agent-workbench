import type { TaskStateSync } from '@awb/domain';
import { createLogger } from '@awb/telemetry';
import { createDaemonClient, type DaemonClient } from '../daemon-client.js';

const log = createLogger('awb-worker');

/**
 * Persists the Workflow's current lifecycle state onto the task row (TASK-123).
 *
 * The Workflow owns phase and condition, and it decides several of them where no phase is running —
 * the terminal `completed` after the loop, a `cancel` signal, and the repeated-failure escalation to
 * `awaiting-human`. So this write cannot live inside `runPhase`: that Activity would have to
 * re-derive the Workflow's routing table and would still miss the states that occur between phases.
 * A dedicated Activity keeps ONE source of truth.
 *
 * Deliberately best-effort. Monitoring must never fail a task: a daemon that is restarting or
 * unreachable makes the row stale, and the daemon's reconcile pass (TASK-126) is the backstop that
 * repairs it. Every other write path in this worker throws on a failed persist, because the
 * lifecycle would otherwise advance on unpersisted state — that reasoning does not apply here.
 */
export async function syncTaskState(state: TaskStateSync, daemon: DaemonClient = createDaemonClient()): Promise<void> {
  try {
    await daemon.syncTaskState(state);
  } catch (err) {
    log.warn('task-state sync failed; the fleet row stays stale until the next write', {
      taskId: state.taskId,
      phase: state.phase,
      condition: state.condition,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
