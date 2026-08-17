import {
  type WorkbenchDatabase,
  getTask,
  getTaskDeliveredBranch,
  listTasksByParent,
  listStartableTasks,
  upsertTask,
  type TaskRow,
} from '@awb/database';

/**
 * Starts one task's workflow. Injected so the scheduler is testable without a real Temporal client.
 * Implementations resolve the base branch lazily (passed in) and call `client.workflow.start`.
 */
export type StartTaskFn = (input: {
  taskId: string;
  repositoryId: string;
  prompt: string;
  baseBranch?: string;
}) => Promise<void>;

/**
 * Reports whether a task has RELEASED — i.e. its draft PR is open (it reached the pr-readiness
 * gate). Used by the poll/boot reconciliation to re-derive eligibility for a blocked child whose
 * parent-released push may have been missed (e.g. across a daemon restart). Injected for the same
 * testability reason. Returns false if the parent's state can't be determined.
 */
export type HasReleasedFn = (parentTaskId: string, repositoryId: string) => Promise<boolean>;

export interface TaskSchedulerOptions {
  database: WorkbenchDatabase;
  startTask: StartTaskFn;
  hasReleased: HasReleasedFn;
}

/**
 * Daemon-side reactive scheduler for the stacked-PR task DAG (task DAG orchestration). A child task
 * is created `blocked` and only started once its parent RELEASES its draft PR. Eligibility is
 * re-derived from SQLite (never in-memory), so a daemon restart recovers by calling `reconcile()`.
 *
 * Two drivers:
 *  - PUSH: the release phase notifies the daemon (`onParentReleased`) the moment a parent's draft
 *    PR opens → its direct children are checked and started immediately (low latency).
 *  - POLL/BOOT: `reconcile()` sweeps all `blocked` tasks and starts any whose parent has released
 *    (the correctness backstop for a missed push or a restart).
 *
 * The scheduler never executes task work; it only starts workflows and writes `schedule_state`.
 */
export class TaskScheduler {
  private readonly database: WorkbenchDatabase;
  private readonly startTaskFn: StartTaskFn;
  private readonly hasReleased: HasReleasedFn;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TaskSchedulerOptions) {
    this.database = options.database;
    this.startTaskFn = options.startTask;
    this.hasReleased = options.hasReleased;
  }

  /** PUSH path: a parent released its draft PR — start any now-eligible direct children. */
  async onParentReleased(parentTaskId: string): Promise<void> {
    const children = listTasksByParent(this.database.db, parentTaskId);
    for (const child of children) {
      if (child.scheduleState === 'blocked') {
        await this.tryStart(child);
      }
    }
  }

  /**
   * POLL/BOOT path: re-derive eligibility for every not-yet-started task from SQLite (roots that
   * are `ready` plus `blocked` children) and start the eligible ones. Also the "start the roots"
   * step right after a DAG is declared. Per-task start failures are swallowed (the task is left for
   * the next tick) so one bad node never aborts the sweep or surfaces as an unhandled rejection —
   * this method runs fire-and-forget from the boot sweep + interval poll.
   */
  async reconcile(): Promise<void> {
    for (const task of listStartableTasks(this.database.db)) {
      try {
        await this.tryStart(task);
      } catch {
        // left blocked/ready for the next tick; tryStart already rolled back the row
      }
    }
  }

  /** Alias used right after declaring a DAG, to start its root nodes immediately. */
  async reconcileReady(): Promise<void> {
    await this.reconcile();
  }

  /** Starts the safety-net poll (correctness backstop for a missed push) + an immediate boot sweep. */
  start(intervalMs = 30_000): void {
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), intervalMs);
    // Don't keep the daemon process alive solely for the poll.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Starts `task` iff it is eligible; idempotent (a task already `started` is skipped). */
  private async tryStart(task: TaskRow): Promise<void> {
    if (task.scheduleState === 'started') return;
    if (!(await this.isEligible(task))) return;

    // Lazily resolve the stacking base from the parent's delivered branch. Guaranteed present once
    // the parent has released (its worktree/lease was created back in the prepare phase).
    let baseBranch: string | undefined;
    if (task.parentTaskId) {
      baseBranch = getTaskDeliveredBranch(this.database.db, task.parentTaskId);
      if (!baseBranch) return; // parent lease not yet materialized — try again next tick
    }

    // Flip to `started` BEFORE starting the workflow so a concurrent tick can't double-start it.
    upsertTask(this.database.db, {
      id: task.id,
      repositoryId: task.repositoryId,
      prompt: task.prompt,
      scheduleState: 'started',
      ...(baseBranch ? { baseBranch } : {}),
    });

    try {
      await this.startTaskFn({
        taskId: task.id,
        repositoryId: task.repositoryId,
        prompt: task.prompt,
        baseBranch,
      });
    } catch (err) {
      // Roll back to the task's PRIOR startable state (root → `ready`, child → `blocked`) so a later
      // tick retries rather than stranding the node as `started`-but-unstarted.
      upsertTask(this.database.db, {
        id: task.id,
        repositoryId: task.repositoryId,
        prompt: task.prompt,
        scheduleState: task.scheduleState ?? 'ready',
      });
      throw err;
    }
  }

  /** A root (no parent) is always eligible; a child is eligible once its parent has released. */
  private async isEligible(task: TaskRow): Promise<boolean> {
    if (!task.parentTaskId) return true;
    const parent = getTask(this.database.db, task.parentTaskId);
    if (!parent) return false;
    return this.hasReleased(task.parentTaskId, task.repositoryId);
  }
}
