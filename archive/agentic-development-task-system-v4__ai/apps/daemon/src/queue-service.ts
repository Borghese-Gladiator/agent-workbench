import {
  planQueueSpec,
  type QueueEntry,
  type QueueSpec,
  specDeps,
  type Task,
} from '@workbench/core';
import type { Store } from '@workbench/store';
import { logger } from './logger.js';
import { HttpError } from './service.js';

const log = logger.child({ component: 'queue' });

/** Accept a single id, a list, or null/undefined; return a deduped id list. */
function normalizeDependsOn(dependsOn: string | string[] | null | undefined): string[] {
  if (dependsOn == null) return [];
  const list = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
  return [...new Set(list)];
}

/**
 * Drives a single task from wherever it sits toward the next gate (kicking the
 * brief if it is still at `intake`), until it parks (gate / terminal / unanswered
 * question). In production this is {@link LifecycleService.driveTask} — injected
 * as a function so the QueueService is testable without the whole service, and so
 * the queue only *schedules* (it never reimplements execution).
 */
export type TaskDriver = (taskId: string) => Promise<Task>;

export interface QueueServiceOptions {
  /**
   * Safety-net poll interval (ms). The queue is primarily event-driven (it
   * re-ticks on every task change), but a poll catches any wakeup that a missed
   * notification would otherwise lose. 0 disables the poll (tests drive `tick`
   * directly). Defaults to 30s.
   */
  pollIntervalMs?: number;
}

/**
 * Schedules enqueued tasks under a dependency DAG with priority/FIFO tiebreaking.
 *
 * The model (locked with the user):
 * - **Ordering:** a queue entry is *eligible* only when EVERY predecessor in its
 *   `dependsOnIds` (other queue entries) has reached `done` — so an entry can
 *   fan in on many upstreams. Among eligible entries, priority desc then
 *   `enqueuedAt` asc (FIFO).
 * - **Concurrency:** unbounded. The ONLY thing holding a task back is an
 *   unsatisfied dependency — N tasks (even in one project) run in parallel, each
 *   in its own worktree.
 * - **`done` only:** a dependent does not start until its predecessor's *task*
 *   reaches the terminal `done` status (its work is delivered), not merely when
 *   the predecessor parks at a gate.
 *
 * The queue never executes work itself: `tick()` hands eligible tasks to the
 * injected {@link TaskDriver} (advanceUntilGate). A task that parks at a human
 * gate keeps its queue entry `running`; only when its task reaches `done` does
 * the entry flip to `done` and unblock its dependents.
 */
export class QueueService {
  private readonly pollIntervalMs: number;
  private unsubscribe: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Queue entries the scheduler has already handed to the driver this process,
   * so a re-tick (from an event or poll) never double-drives a task that is
   * mid-flight. Keyed by queue-entry id; cleared when the entry leaves `running`.
   */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly driver: TaskDriver,
    opts: QueueServiceOptions = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  }

  /**
   * Enqueue a task. `dependsOn` (one or more queue-entry ids) must each reach
   * `done` before this entry becomes eligible. Validates that every dependency
   * exists, that the task isn't already queued, and that adding the edges
   * introduces no cycle.
   */
  enqueue(input: {
    taskId: string;
    dependsOn?: string | string[] | null;
    priority?: number;
  }): QueueEntry {
    if (!this.store.getTask(input.taskId)) {
      throw new HttpError(404, `Task not found: ${input.taskId}`);
    }
    if (this.store.getQueueEntryForTask(input.taskId)) {
      throw new HttpError(409, `Task already enqueued: ${input.taskId}`);
    }
    const dependsOnIds = normalizeDependsOn(input.dependsOn);
    for (const depId of dependsOnIds) {
      if (!this.store.getQueueEntry(depId)) {
        throw new HttpError(400, `dependsOn queue entry not found: ${depId}`);
      }
    }
    this.assertNoCycle(dependsOnIds);
    const entry = this.store.enqueueTask({
      taskId: input.taskId,
      dependsOnIds,
      priority: input.priority ?? 0,
    });
    log.info(
      {
        queueId: entry.id,
        taskId: entry.taskId,
        dependsOn: dependsOnIds,
        priority: entry.priority,
      },
      'enqueued task',
    );
    // A no-dependency entry may be runnable right now.
    void this.tick();
    return entry;
  }

  /**
   * Create a whole DAG of tasks + queue entries + edges atomically. Validates the
   * spec (unique keys, known refs, acyclic) and topologically sorts it, then hands
   * the ordered batch to the store's single-transaction `createQueueDag` — a
   * mid-batch failure rolls everything back, so no partial DAG is ever left. Ticks
   * once after commit so the no-dependency roots start immediately.
   */
  enqueueDag(spec: QueueSpec): Array<{ key: string; taskId: string; queueEntry: QueueEntry }> {
    let order: string[];
    try {
      order = planQueueSpec(spec);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    const byKey = new Map(spec.tasks.map((t) => [t.key, t]));
    // Emit tasks in dependency order so each predecessor's queue id exists first.
    const orderedTasks = order.map((key) => {
      const t = byKey.get(key)!;
      return {
        key: t.key,
        title: t.title,
        request: t.request,
        dependsOnKeys: specDeps(t),
        ...(t.priority === undefined ? {} : { priority: t.priority }),
      };
    });

    const created = this.store.createQueueDag({ projectId: spec.projectId, tasks: orderedTasks });
    log.info({ projectId: spec.projectId, count: created.length }, 'created task DAG (atomic)');
    void this.tick();
    return created;
  }

  /**
   * Reject a cycle in the DAG formed by adding a new entry whose edges point to
   * `newEdges`. The new entry isn't persisted yet (nothing points at it), so it
   * cannot itself close a loop; a cycle is only possible if the *existing*
   * ancestor graph above a proposed predecessor is already corrupt. DFS up the
   * `dependsOnIds` edges, tracking the active path so revisiting a node on that
   * path is a real cycle while a diamond (a node reached via two branches) is not.
   */
  private assertNoCycle(newEdges: string[]): void {
    const explored = new Set<string>();
    const visit = (nodeId: string, path: Set<string>): void => {
      if (path.has(nodeId)) {
        throw new HttpError(400, `dependency cycle detected at queue entry ${nodeId}`);
      }
      if (explored.has(nodeId)) return;
      path.add(nodeId);
      for (const predId of this.store.getQueueEntry(nodeId)?.dependsOnIds ?? []) {
        visit(predId, path);
      }
      path.delete(nodeId);
      explored.add(nodeId);
    };
    for (const edge of newEdges) visit(edge, new Set());
  }

  list(): QueueEntry[] {
    return this.store.listQueue();
  }

  /**
   * Start the event-driven scheduler: re-tick on every task change (so a task
   * reaching `done` immediately unblocks its dependents) plus a slow safety poll.
   * Returns a stop function. An initial tick runs so anything enqueued before
   * start (e.g. restored on boot) gets picked up.
   */
  start(): () => void {
    this.unsubscribe = this.store.onTaskChange((taskId) => this.onTaskChange(taskId));
    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => void this.tick(), this.pollIntervalMs);
      // Don't keep the process alive solely for the queue poll.
      this.pollTimer.unref?.();
    }
    void this.tick();
    return () => this.stop();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * React to a task state change: if the changed task owns a `running` queue
   * entry and has reached `done`, close the entry (which unblocks dependents),
   * then re-tick. Cheap and idempotent — duplicate notifications are harmless.
   */
  private onTaskChange(taskId: string): void {
    const entry = this.store.getQueueEntryForTask(taskId);
    if (entry && entry.status === 'running') {
      const task = this.store.getTask(taskId);
      if (task?.status === 'done') {
        this.completeEntry(entry, 'done');
      } else if (task?.status === 'abandoned') {
        this.completeEntry(entry, 'failed');
      }
    }
    void this.tick();
  }

  private completeEntry(entry: QueueEntry, status: 'done' | 'failed'): void {
    this.store.setQueueStatus(entry.id, status);
    this.inFlight.delete(entry.id);
    log.info({ queueId: entry.id, taskId: entry.taskId, status }, 'queue entry finished');
  }

  /**
   * One scheduling pass: hand every eligible, not-already-in-flight queue entry
   * to the driver. Each drive is detached — a task parking at a gate must not
   * block scheduling of its siblings, and the unbounded-concurrency decision
   * means we never wait for a slot. Re-entrant-safe via `inFlight`.
   */
  async tick(): Promise<void> {
    const eligible = this.store.listEligibleQueued();
    for (const entry of eligible) {
      if (this.inFlight.has(entry.id)) continue;
      this.inFlight.add(entry.id);
      this.store.setQueueStatus(entry.id, 'running');
      log.info({ queueId: entry.id, taskId: entry.taskId }, 'driving queued task');
      this.drive(entry);
    }
  }

  /**
   * Detached drive of one entry's task. On the task reaching a terminal status we
   * close the entry here too (belt-and-braces with `onTaskChange`, which also
   * fires from the store write); on a gate-park we leave it `running` and clear
   * the in-flight guard so a later resume can re-drive it. A driver failure marks
   * the entry `failed` so the queue doesn't wedge on it.
   */
  private drive(entry: QueueEntry): void {
    this.driver(entry.taskId)
      .then((task) => {
        if (task.status === 'done') {
          this.completeEntry(entry, 'done');
          void this.tick();
        } else if (task.status === 'abandoned') {
          this.completeEntry(entry, 'failed');
          void this.tick();
        } else {
          // Parked at a gate / awaiting input: the entry stays `running`. Clear
          // the in-flight guard so a later wakeup (gate approval -> task change)
          // can re-drive it.
          this.inFlight.delete(entry.id);
        }
      })
      .catch((err) => {
        this.completeEntry(entry, 'failed');
        log.error(
          {
            queueId: entry.id,
            taskId: entry.taskId,
            err: err instanceof Error ? err.message : String(err),
          },
          'queue drive failed (isolated)',
        );
      });
  }
}
