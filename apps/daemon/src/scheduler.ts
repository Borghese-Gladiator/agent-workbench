import {
  type WorkbenchDatabase,
  getTask,
  getTaskDeliveredBranch,
  listStartableTasks,
  listTasksByParent,
  listParentsOf,
  listDependentsOf,
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

  /**
   * PUSH path: a predecessor released its draft PR — re-evaluate every dependent (fan-in reconcile,
   * TASK-102) and start those whose predecessors have ALL released. A dependent is reached via the
   * task_dependencies edge table (both 'stack' and 'after' edges), so a diamond child unblocks only
   * once BOTH of its predecessors have released.
   */
  async onParentReleased(parentTaskId: string): Promise<void> {
    // Dependents come from the edge table (both 'stack' and 'after') AND, for back-compat with
    // directly-created stacking tasks that carry only parent_task_id (no edge row), from
    // listTasksByParent. Dedup so a task reachable both ways is evaluated once.
    const dependentIds = new Set<string>();
    for (const edge of listDependentsOf(this.database.db, parentTaskId)) dependentIds.add(edge.taskId);
    for (const child of listTasksByParent(this.database.db, parentTaskId)) dependentIds.add(child.id);
    for (const dependentId of dependentIds) {
      const dependent = getTask(this.database.db, dependentId);
      if (dependent && dependent.scheduleState === 'blocked') {
        await this.tryStart(dependent);
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

  /**
   * A task is eligible only when EVERY predecessor has released (fan-in, TASK-102). A root (no
   * predecessor edges) is always eligible. Both 'stack' and 'after' edges gate the start; the mode
   * only matters for base-branch resolution, not for eligibility.
   */
  private async isEligible(task: TaskRow): Promise<boolean> {
    const parents = listParentsOf(this.database.db, task.id);
    // Back-compat: a directly-created stacking child may carry parent_task_id without an edge row.
    if (parents.length === 0 && !task.parentTaskId) return true;
    const predecessorIds = new Set(parents.map((e) => e.dependsOnTaskId));
    if (task.parentTaskId) predecessorIds.add(task.parentTaskId);
    for (const predecessorId of predecessorIds) {
      const predecessor = getTask(this.database.db, predecessorId);
      if (!predecessor) return false;
      if (!(await this.hasReleased(predecessorId, task.repositoryId))) return false;
    }
    return true;
  }
}
