import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

let store: Store;
let dir: string;
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-queue-'));
  store = new Store({ dbPath: ':memory:', artifactsDir: dir });
  projectId = store.createProject({ name: 'P', repoPath: '/tmp/repo', defaultBranch: 'main' }).id;
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const newTask = (title = 't') => store.createTask({ projectId, title, rawRequest: 'r' });

const markDone = (taskId: string) =>
  store.applyTransition(taskId, { stage: 'closeout', status: 'done' });

describe('Store task_queue', () => {
  it('enqueues a task and reads it back', () => {
    const task = newTask();
    const entry = store.enqueueTask({ taskId: task.id, priority: 5 });
    expect(entry.status).toBe('queued');
    expect(entry.priority).toBe(5);
    expect(entry.dependsOnIds).toEqual([]);
    expect(store.getQueueEntryForTask(task.id)?.id).toBe(entry.id);
  });

  it('enforces one queue entry per task (unique index)', () => {
    const task = newTask();
    store.enqueueTask({ taskId: task.id });
    expect(() => store.enqueueTask({ taskId: task.id })).toThrow();
  });

  it('setQueueStatus stamps started/completed timestamps', () => {
    const entry = store.enqueueTask({ taskId: newTask().id });
    expect(store.setQueueStatus(entry.id, 'running')?.startedAt).not.toBeNull();
    const done = store.setQueueStatus(entry.id, 'done');
    expect(done?.status).toBe('done');
    expect(done?.completedAt).not.toBeNull();
  });

  describe('listEligibleQueued', () => {
    it('returns a no-dependency entry immediately', () => {
      const entry = store.enqueueTask({ taskId: newTask().id });
      expect(store.listEligibleQueued().map((e) => e.id)).toEqual([entry.id]);
    });

    it('withholds an entry until its predecessor task is done', () => {
      const a = newTask('A');
      const b = newTask('B');
      const qa = store.enqueueTask({ taskId: a.id });
      const qb = store.enqueueTask({ taskId: b.id, dependsOnIds: [qa.id] });

      // B is blocked while A is not done.
      expect(store.listEligibleQueued().map((e) => e.id)).toEqual([qa.id]);

      markDone(a.id);
      // Now both A (still queued) and B are eligible.
      expect(
        store
          .listEligibleQueued()
          .map((e) => e.id)
          .sort(),
      ).toEqual([qa.id, qb.id].sort());
    });

    it('a non-terminal predecessor status does NOT satisfy the dependency', () => {
      const a = newTask('A');
      const b = newTask('B');
      const qa = store.enqueueTask({ taskId: a.id });
      store.enqueueTask({ taskId: b.id, dependsOnIds: [qa.id] });

      // Parked at a human gate is NOT 'done'.
      store.applyTransition(a.id, { stage: 'human_review', status: 'active' });
      expect(store.listEligibleQueued().map((e) => e.taskId)).toEqual([a.id]);
    });

    it('orders eligible entries by priority desc then enqueue order (FIFO)', () => {
      const low = store.enqueueTask({ taskId: newTask('low').id, priority: 0 });
      const high = store.enqueueTask({ taskId: newTask('high').id, priority: 10 });
      const mid1 = store.enqueueTask({ taskId: newTask('mid1').id, priority: 5 });
      const mid2 = store.enqueueTask({ taskId: newTask('mid2').id, priority: 5 });

      expect(store.listEligibleQueued().map((e) => e.id)).toEqual([
        high.id,
        mid1.id, // same priority as mid2, enqueued first
        mid2.id,
        low.id,
      ]);
    });

    it('omits running/done entries', () => {
      const a = store.enqueueTask({ taskId: newTask('A').id });
      const b = store.enqueueTask({ taskId: newTask('B').id });
      store.setQueueStatus(a.id, 'running');
      expect(store.listEligibleQueued().map((e) => e.id)).toEqual([b.id]);
      store.setQueueStatus(b.id, 'done');
      expect(store.listEligibleQueued()).toEqual([]);
    });

    it('withholds a fan-in entry until ALL predecessors are done', () => {
      const a = newTask('A');
      const b = newTask('B');
      const c = newTask('C');
      const qa = store.enqueueTask({ taskId: a.id });
      const qb = store.enqueueTask({ taskId: b.id });
      const qc = store.enqueueTask({ taskId: c.id, dependsOnIds: [qa.id, qb.id] });

      // Only the two roots are eligible; C waits on both.
      expect(
        store
          .listEligibleQueued()
          .map((e) => e.id)
          .sort(),
      ).toEqual([qa.id, qb.id].sort());

      // One predecessor done is not enough.
      markDone(a.id);
      expect(store.listEligibleQueued().map((e) => e.id)).not.toContain(qc.id);

      // Both done -> C becomes eligible.
      markDone(b.id);
      expect(store.listEligibleQueued().map((e) => e.id)).toContain(qc.id);
    });
  });

  it('hydrates dependsOnIds from the edge table (0, 1, 2 edges)', () => {
    const qa = store.enqueueTask({ taskId: newTask('A').id });
    const qb = store.enqueueTask({ taskId: newTask('B').id });
    const solo = store.enqueueTask({ taskId: newTask('solo').id });
    const one = store.enqueueTask({ taskId: newTask('one').id, dependsOnIds: [qa.id] });
    const two = store.enqueueTask({ taskId: newTask('two').id, dependsOnIds: [qa.id, qb.id] });

    expect(store.getQueueEntry(solo.id)?.dependsOnIds).toEqual([]);
    expect(store.getQueueEntry(one.id)?.dependsOnIds).toEqual([qa.id]);
    expect(store.getQueueEntry(two.id)?.dependsOnIds.sort()).toEqual([qa.id, qb.id].sort());
  });
});

describe('Store.createQueueDag', () => {
  it('creates a fan-in DAG (tasks + queue entries + edges) in one call', () => {
    const created = store.createQueueDag({
      projectId,
      tasks: [
        { key: 'fix', title: 'Fix', request: 'r', dependsOnKeys: [], priority: 100 },
        { key: 'test', title: 'Test', request: 'r', dependsOnKeys: [] },
        { key: 'release', title: 'Release', request: 'r', dependsOnKeys: ['fix', 'test'] },
      ],
    });
    expect(created.map((c) => c.key)).toEqual(['fix', 'test', 'release']);

    const release = created.find((c) => c.key === 'release')!;
    const fix = created.find((c) => c.key === 'fix')!;
    const test = created.find((c) => c.key === 'test')!;
    expect(store.getQueueEntry(release.queueEntry.id)?.dependsOnIds.sort()).toEqual(
      [fix.queueEntry.id, test.queueEntry.id].sort(),
    );
    // The tasks are real, distinct, and enqueued.
    expect(store.getTask(fix.taskId)?.title).toBe('Fix');
    expect(store.listQueue()).toHaveLength(3);
  });

  it('rolls back the WHOLE batch if any task fails (no partial DAG)', () => {
    const before = store.listTasks().length;
    // Second task depends on a key that was not created first -> throws mid-batch.
    expect(() =>
      store.createQueueDag({
        projectId,
        tasks: [
          { key: 'a', title: 'A', request: 'r', dependsOnKeys: [] },
          { key: 'b', title: 'B', request: 'r', dependsOnKeys: ['ghost'] },
        ],
      }),
    ).toThrow();

    // Nothing persisted: not even task 'a' that "succeeded" before the failure.
    expect(store.listTasks().length).toBe(before);
    expect(store.listQueue()).toEqual([]);
  });
});
