import type { StageRun, Task, Timestamp } from './entities.js';

/**
 * Timing helpers derived from the timestamps the lifecycle already records:
 * `Task.createdAt`/`updatedAt` and `StageRun.enteredAt`/`completedAt`. Nothing
 * new is persisted — these compute elapsed wall-clock from what's stored.
 *
 * All functions are pure; `now` is injectable so callers (and tests) control the
 * clock for "live" durations (a still-running task or an in-progress stage).
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Parse an ISO timestamp to epoch ms, or null if unparseable. */
function toMs(ts: Timestamp | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Format a duration in ms as a compact human string: `0.4s`, `12s`, `3m 4s`,
 * `1h 2m`. Sub-minute durations keep one decimal under 10s for precision;
 * minutes and hours round to whole units and drop the smaller trailing unit
 * when it's zero. Negative inputs clamp to `0s`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 10 * SECOND) return `${(ms / SECOND).toFixed(1)}s`;
  if (ms < MINUTE) return `${Math.round(ms / SECOND)}s`;
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE);
    const s = Math.round((ms % MINUTE) / SECOND);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / HOUR);
  const m = Math.round((ms % HOUR) / MINUTE);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Wall-clock ms a single stage run took. Completed runs use
 * `completedAt - enteredAt`; an in-progress run measures from `enteredAt` to
 * `now` (the live, still-accruing duration). Returns null if `enteredAt` is
 * unparseable.
 */
export function stageRunDurationMs(run: StageRun, now: number = Date.now()): number | null {
  const start = toMs(run.enteredAt);
  if (start == null) return null;
  const end = toMs(run.completedAt) ?? now;
  return Math.max(0, end - start);
}

/**
 * Total wall-clock ms the task has been alive: from `createdAt` to `updatedAt`
 * once terminal (done/abandoned), otherwise to `now` (still running). Returns
 * null if `createdAt` is unparseable.
 */
export function taskElapsedMs(task: Task, now: number = Date.now()): number | null {
  const start = toMs(task.createdAt);
  if (start == null) return null;
  const terminal = task.status === 'done' || task.status === 'abandoned';
  const end = terminal ? (toMs(task.updatedAt) ?? now) : now;
  return Math.max(0, end - start);
}

/**
 * Wall-clock ms one Claude session (AgentRun) ran. Finished runs use
 * `finishedAt - startedAt`; a still-running (or awaiting-input) run measures to
 * `now`. Duck-typed on the timing fields so both core's `AgentRun` and the
 * client's structural mirror satisfy it. Returns null if `startedAt` is
 * unparseable.
 */
export function agentRunDurationMs(
  run: { startedAt: Timestamp; finishedAt: Timestamp | null },
  now: number = Date.now(),
): number | null {
  const start = toMs(run.startedAt);
  if (start == null) return null;
  const end = toMs(run.finishedAt) ?? now;
  return Math.max(0, end - start);
}
