/**
 * QueueService tests: dependency-DAG eligibility, priority/FIFO ordering, the
 * detached drive lifecycle (done unblocks dependents; a gate-park keeps the entry
 * running; a failure doesn't wedge the queue), cycle rejection, and the
 * event-driven re-tick off store changes. The driver is faked so these exercise
 * SCHEDULING only — execution is advanceUntilGate's job, covered elsewhere.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@workbench/core';
import { Store } from '@workbench/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from './queue-service.js';
import { HttpError } from './service.js';

let store: Store;
let dir: string;
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-qsvc-'));
  store = new Store({ dbPath: ':memory:', artifactsDir: dir });
  projectId = store.createProject({ name: 'P', repoPath: '/tmp/repo', defaultBranch: 'main' }).id;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const newTask = (title = 't') => store.createTask({ projectId, title, rawRequest: 'r' });

/** Drives a task to `done` (terminal closeout) — the happy path. */
const driveToDone = (taskId: string): Promise<Task> =>
  Promise.resolve(store.applyTransition(taskId, { stage: 'closeout', status: 'done' }));

/** Parks a task at a human gate (non-terminal) — entry should stay `running`. */
const driveToGate = (taskId: string): Promise<Task> =>
  Promise.resolve(store.applyTransition(taskId, { stage: 'human_review', status: 'active' }));

/** Let detached drive promises settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('QueueService.enqueue', () => {
  it('rejects an unknown task', () => {
    const q = new QueueService(store, driveToDone, { pollIntervalMs: 0 });
    expect(() => q.enqueue({ taskId: 'nope' })).toThrow(HttpError);
  });

  it('rejects enqueuing the same task twice', () => {
    const q = new QueueService(store, async (t) => store.getTask(t)!, { pollIntervalMs: 0 });
    const task = newTask();
    q.enqueue({ taskId: task.id });
    expect(() => q.enqueue({ taskId: task.id })).toThrow(/already enqueued/);
  });

  it('rejects a dependsOn that is not a queue entry', () => {
    const q = new QueueService(store, async (t) => store.getTask(t)!, { pollIntervalMs: 0 });
    expect(() => q.enqueue({ taskId: newTask().id, dependsOn: 'q_missing' })).toThrow(
      /dependsOn queue entry not found/,
    );
  });

  it('accepts a deep linear dependency chain (no false cycle)', () => {
    const q = new QueueService(store, async (t) => store.getTask(t)!, { pollIntervalMs: 0 });
    const a = q.enqueue({ taskId: newTask('A').id });
    const b = q.enqueue({ taskId: newTask('B').id, dependsOn: a.id });
    const c = q.enqueue({ taskId: newTask('C').id, dependsOn: b.id });
    expect(() => q.enqueue({ taskId: newTask('D').id, dependsOn: c.id })).not.toThrow();
  });

  it('accepts a fan-in dependency (two predecessors, no false cycle)', () => {
    const q = new QueueService(store, async (t) => store.getTask(t)!, { pollIntervalMs: 0 });
    const a = q.enqueue({ taskId: newTask('A').id });
    const b = q.enqueue({ taskId: newTask('B').id });
    const entry = q.enqueue({ taskId: newTask('C').id, dependsOn: [a.id, b.id] });
    expect(entry.dependsOnIds.sort()).toEqual([a.id, b.id].sort());
  });

  it('rejects a cycle in a corrupted dependency graph (defensive guard)', () => {
    // The public enqueue API can't form a loop (the new row isn't persisted yet),
    // so corrupt the graph directly: A -> B -> A, then enqueue D -> A and assert
    // assertNoCycle catches the loop while walking up from A.
    const q = new QueueService(store, async (t) => store.getTask(t)!, { pollIntervalMs: 0 });
    const a = store.enqueueTask({ taskId: newTask('A').id });
    const b = store.enqueueTask({ taskId: newTask('B').id, dependsOnIds: [a.id] });
    addEdge(store, a.id, b.id); // close the loop: a -> b -> a
    expect(() => q.enqueue({ taskId: newTask('D').id, dependsOn: a.id })).toThrow(/cycle/);
  });
});

/** Test-only raw write to forge a dependency edge the public API won't create. */
function addEdge(store: Store, queueId: string, dependsOnId: string): void {
  (
    store as unknown as { sqlite: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
  ).sqlite
    .prepare(
      'INSERT INTO queue_dependencies (queue_id, depends_on_id, created_at) VALUES (?, ?, ?)',
    )
    .run(queueId, dependsOnId, new Date().toISOString());
}

describe('QueueService scheduling', () => {
  it('drives a no-dependency entry to done on enqueue', async () => {
    const driver = vi.fn(driveToDone);
    const q = new QueueService(store, driver, { pollIntervalMs: 0 });
    const task = newTask();
    const entry = q.enqueue({ taskId: task.id });
    await flush();
    expect(driver).toHaveBeenCalledWith(task.id);
    expect(store.getQueueEntry(entry.id)?.status).toBe('done');
  });

  it('keeps an entry running when its task parks at a gate', async () => {
    const q = new QueueService(store, driveToGate, { pollIntervalMs: 0 });
    const entry = q.enqueue({ taskId: newTask().id });
    await flush();
    expect(store.getQueueEntry(entry.id)?.status).toBe('running');
  });

  it('runs a dependent only after its predecessor task is done', async () => {
    const driver = vi.fn(driveToGate); // park everything; we flip status manually
    const q = new QueueService(store, driver, { pollIntervalMs: 0 });
    const stop = q.start(); // wire the event-driven re-tick off store changes
    const a = newTask('A');
    const b = newTask('B');
    const qa = q.enqueue({ taskId: a.id });
    const qb = q.enqueue({ taskId: b.id, dependsOn: qa.id });
    await flush();

    // A was driven (parked); B is still queued because A isn't done.
    expect(driver).toHaveBeenCalledWith(a.id);
    expect(driver).not.toHaveBeenCalledWith(b.id);
    expect(store.getQueueEntry(qb.id)?.status).toBe('queued');

    // A reaches done -> the store change re-ticks -> B becomes eligible.
    store.applyTransition(a.id, { stage: 'closeout', status: 'done' });
    await flush();
    expect(store.getQueueEntry(qa.id)?.status).toBe('done');
    expect(driver).toHaveBeenCalledWith(b.id);
    stop();
  });

  it('fans out: C and D both run once B is done (diamond)', async () => {
    const driven: string[] = [];
    const driver = vi.fn(async (taskId: string) => {
      driven.push(taskId);
      return store.getTask(taskId)!; // park (non-terminal) by default
    });
    const q = new QueueService(store, driver, { pollIntervalMs: 0 });
    const stop = q.start(); // wire the event-driven re-tick off store changes
    const a = newTask('A');
    const b = newTask('B');
    const c = newTask('C');
    const d = newTask('D');
    const qa = q.enqueue({ taskId: a.id });
    const qb = q.enqueue({ taskId: b.id, dependsOn: qa.id });
    q.enqueue({ taskId: c.id, dependsOn: qb.id });
    q.enqueue({ taskId: d.id, dependsOn: qb.id });
    await flush();

    store.applyTransition(a.id, { stage: 'closeout', status: 'done' });
    await flush();
    store.applyTransition(b.id, { stage: 'closeout', status: 'done' });
    await flush();

    // Both downstream tasks were driven after B completed.
    expect(driven).toContain(c.id);
    expect(driven).toContain(d.id);
    stop();
  });

  it('fans in: C runs only after BOTH A and B are done', async () => {
    const driven: string[] = [];
    const driver = vi.fn(async (taskId: string) => {
      driven.push(taskId);
      return store.getTask(taskId)!; // park (non-terminal) by default
    });
    const q = new QueueService(store, driver, { pollIntervalMs: 0 });
    const stop = q.start();
    const a = newTask('A');
    const b = newTask('B');
    const c = newTask('C');
    const qa = q.enqueue({ taskId: a.id });
    const qb = q.enqueue({ taskId: b.id });
    q.enqueue({ taskId: c.id, dependsOn: [qa.id, qb.id] });
    await flush();

    // Only one predecessor done -> C still withheld.
    store.applyTransition(a.id, { stage: 'closeout', status: 'done' });
    await flush();
    expect(driven).not.toContain(c.id);

    // Both done -> C is driven.
    store.applyTransition(b.id, { stage: 'closeout', status: 'done' });
    await flush();
    expect(driven).toContain(c.id);
    stop();
  });

  it('higher priority among eligible entries is driven first', async () => {
    const order: string[] = [];
    const driver = vi.fn(async (taskId: string) => {
      order.push(taskId);
      return store.getTask(taskId)!; // park
    });
    const q = new QueueService(store, driver, { pollIntervalMs: 0 });
    const low = newTask('low');
    const high = newTask('high');
    // Enqueue low first, then high with greater priority; a single tick should
    // order them high-before-low.
    store.enqueueTask({ taskId: low.id, priority: 0 });
    store.enqueueTask({ taskId: high.id, priority: 10 });
    await q.tick();
    await flush();
    expect(order).toEqual([high.id, low.id]);
  });

  it('a driver failure marks the entry failed and does not wedge the queue', async () => {
    const q = new QueueService(
      store,
      async (taskId: string) => {
        if (store.getTask(taskId)?.title === 'boom') throw new Error('drive exploded');
        return driveToDone(taskId);
      },
      { pollIntervalMs: 0 },
    );
    const bad = q.enqueue({ taskId: newTask('boom').id });
    const good = q.enqueue({ taskId: newTask('fine').id });
    await flush();
    expect(store.getQueueEntry(bad.id)?.status).toBe('failed');
    expect(store.getQueueEntry(good.id)?.status).toBe('done');
  });

  it('does not double-drive a task that is mid-flight', async () => {
    let resolveDrive: (t: Task) => void = () => {};
    const driver = vi.fn((taskId: string) =>
      new Promise<Task>((resolve) => {
        resolveDrive = resolve;
      }).then(() => store.getTask(taskId)!),
    );
    const q = new QueueService(store, driver, { pollIntervalMs: 0 });
    const task = newTask();
    q.enqueue({ taskId: task.id });
    await flush();
    // A second tick while the first drive is still pending must not re-invoke.
    await q.tick();
    await flush();
    expect(driver).toHaveBeenCalledTimes(1);
    resolveDrive(store.getTask(task.id)!);
  });
});
