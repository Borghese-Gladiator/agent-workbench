/**
 * Boot reconciliation — restore the invariant that every spawned process and
 * every in-flight conversation is either owned by a live daemon or
 * deterministically reconciled on boot, never silently orphaned.
 *
 * Two independent steps, called from main.ts AFTER `store.markInterruptedRuns()`:
 *   1. reapOrphanProcessGroups — SIGKILL the process group of each interrupted
 *      run whose group is still alive AND verifiably ours (guards PID reuse).
 *   2. (resume engine lives in the service: LifecycleService.resumeInterruptedRuns)
 *
 * The reaper is intentionally free of the resume step so it's independently
 * testable and so a failure to resume can't prevent us from killing orphans.
 */

import { execFileSync } from 'node:child_process';
import type { AgentRun } from '@workbench/core';
import { logger } from './logger.js';

/**
 * Injectable OS seam so tests don't signal real pids unless they choose to. In
 * production these wrap `process.kill` and `ps`.
 */
export interface ProcessControl {
  /** True if the process group is alive (signal 0 probe). */
  isGroupAlive(pgid: number): boolean;
  /**
   * The group leader's command line (for identity verification), or null if it
   * can't be read. In production: `ps -p <pgid> -o command=`.
   */
  groupLeaderCommand(pgid: number): string | null;
  /** SIGKILL the whole process group (negative pid). */
  killGroup(pgid: number): void;
}

/** Default control bound to the real OS. */
export const realProcessControl: ProcessControl = {
  isGroupAlive(pgid) {
    try {
      // Signal 0 doesn't deliver — it only checks existence/permission. The
      // group leader pid == pgid for a detached child, so probe that pid.
      process.kill(pgid, 0);
      return true;
    } catch {
      return false;
    }
  },
  groupLeaderCommand(pgid) {
    try {
      return execFileSync('ps', ['-p', String(pgid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
    } catch {
      return null;
    }
  },
  killGroup(pgid) {
    // Negative pid targets the whole process group (the claude CLI + its child
    // MCP ask-server), so one signal reaps the tree.
    process.kill(-pgid, 'SIGKILL');
  },
};

export interface ReapResult {
  killed: number;
  /** Group gone already (nothing to do). */
  stale: number;
  /** Alive but identity couldn't be confirmed — left untouched on purpose. */
  skipped: number;
}

/**
 * For each interrupted run with a recorded process group, kill that group iff it
 * is (a) still alive and (b) verifiably the agent we spawned. Verification = the
 * group leader's command line mentions `claude` AND the run's worktree path; an
 * unverifiable pid is SKIPPED, never killed, so we can't take out a recycled pid
 * or a human's hand-launched `claude` in the same worktree.
 *
 * `worktreePathFor` resolves a run's worktree path for the identity check (the
 * service knows how; tests stub it). Returns counts for logging.
 */
export function reapOrphanProcessGroups(
  runs: AgentRun[],
  worktreePathFor: (run: AgentRun) => string | undefined,
  control: ProcessControl = realProcessControl,
): ReapResult {
  const result: ReapResult = { killed: 0, stale: 0, skipped: 0 };
  for (const run of runs) {
    if (run.pgid == null) continue; // mock run / legacy row — nothing was spawned
    const pgid = run.pgid;
    const log = logger.child({ runId: run.id, pgid });

    if (!control.isGroupAlive(pgid)) {
      result.stale++;
      log.info('orphan reap: process group already gone');
      continue;
    }

    const cmd = control.groupLeaderCommand(pgid);
    const worktreePath = worktreePathFor(run);
    const verified =
      cmd != null &&
      cmd.includes('claude') &&
      worktreePath != null &&
      worktreePath.length > 0 &&
      cmd.includes(worktreePath);

    if (!verified) {
      result.skipped++;
      log.warn(
        { cmd, worktreePath },
        'orphan reap: pid alive but identity unverified — skipping (possible pid reuse)',
      );
      continue;
    }

    try {
      control.killGroup(pgid);
      result.killed++;
      log.warn('orphan reap: killed process group of interrupted run');
    } catch (err) {
      result.skipped++;
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'orphan reap: kill failed',
      );
    }
  }
  return result;
}
