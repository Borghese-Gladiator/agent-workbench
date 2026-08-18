import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  repositories,
  workspaceLeases,
  upsertTask,
  getTask,
  insertTaskDependency,
  type WorkbenchDatabase,
} from '@awb/database';
import { TaskScheduler, type StartTaskFn } from './scheduler.js';

const REPO = 'repo-1';

function seedRepo(db: WorkbenchDatabase): void {
  const now = new Date().toISOString();
  db.db
    .insert(repositories)
    .values({ id: REPO, canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
    .run();
}

/** Give a task a workspace lease (its delivered branch) — what a released parent has. */
function seedLease(db: WorkbenchDatabase, taskId: string, branchName: string): void {
  db.db
    .insert(workspaceLeases)
    .values({ id: `${taskId}-lease`, repositoryId: REPO, taskId, baseRef: 'main', baseSha: 'sha', branchName, worktreePath: '/tmp/wt', executionProfile: 'native-trusted', allocatedPortsJson: '[]', state: 'active', createdAt: new Date().toISOString() })
    .run();
}

describe('TaskScheduler', () => {
  let dir: string;
  let db: WorkbenchDatabase;
  let started: { taskId: string; baseBranch?: string }[];
  const releasedParents = new Set<string>();

  const recordingStart: StartTaskFn = async (input) => {
    started.push({ taskId: input.taskId, baseBranch: input.baseBranch });
  };
  function scheduler(): TaskScheduler {
    return new TaskScheduler({
      database: db,
      startTask: recordingStart,
      hasReleased: async (parentTaskId) => releasedParents.has(parentTaskId),
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-scheduler-'));
    db = createDatabase(join(dir, 'wb.sqlite'));
    seedRepo(db);
    started = [];
    releasedParents.clear();
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('starts a root (no parent) on reconcile and marks it started', async () => {
    upsertTask(db.db, { id: 'root', repositoryId: REPO, prompt: 'p', scheduleState: 'ready' });
    await scheduler().reconcile();
    expect(started.map((s) => s.taskId)).toEqual(['root']);
    expect(getTask(db.db, 'root')?.scheduleState).toBe('started');
  });

  it('does NOT start a blocked child until its parent has released', async () => {
    upsertTask(db.db, { id: 'A', repositoryId: REPO, prompt: 'A', scheduleState: 'started' });
    upsertTask(db.db, { id: 'B', repositoryId: REPO, prompt: 'B', parentTaskId: 'A', scheduleState: 'blocked' });

    await scheduler().reconcile();
    expect(started).toHaveLength(0);
    expect(getTask(db.db, 'B')?.scheduleState).toBe('blocked');
  });

  it('starts a blocked child with the parent branch as base once the parent releases', async () => {
    upsertTask(db.db, { id: 'A', repositoryId: REPO, prompt: 'A', scheduleState: 'started' });
    upsertTask(db.db, { id: 'B', repositoryId: REPO, prompt: 'B', parentTaskId: 'A', scheduleState: 'blocked' });
    seedLease(db, 'A', 'awb/A-slug');
    releasedParents.add('A');

    await scheduler().onParentReleased('A');

    expect(started).toEqual([{ taskId: 'B', baseBranch: 'awb/A-slug' }]);
    expect(getTask(db.db, 'B')?.scheduleState).toBe('started');
    // The resolved base is persisted onto the child row.
    expect(getTask(db.db, 'B')?.baseBranch).toBe('awb/A-slug');
  });

  it('onParentReleased only unblocks DIRECT children (not grandchildren)', async () => {
    upsertTask(db.db, { id: 'A', repositoryId: REPO, prompt: 'A', scheduleState: 'started' });
    upsertTask(db.db, { id: 'B', repositoryId: REPO, prompt: 'B', parentTaskId: 'A', scheduleState: 'blocked' });
    upsertTask(db.db, { id: 'C', repositoryId: REPO, prompt: 'C', parentTaskId: 'B', scheduleState: 'blocked' });
    seedLease(db, 'A', 'awb/A-slug');
    releasedParents.add('A');

    await scheduler().onParentReleased('A');

    // Only B starts; C stays blocked (its parent B hasn't released).
    expect(started.map((s) => s.taskId)).toEqual(['B']);
    expect(getTask(db.db, 'C')?.scheduleState).toBe('blocked');
  });

  it('is idempotent — a started task is never re-started', async () => {
    upsertTask(db.db, { id: 'A', repositoryId: REPO, prompt: 'A', scheduleState: 'started' });
    upsertTask(db.db, { id: 'B', repositoryId: REPO, prompt: 'B', parentTaskId: 'A', scheduleState: 'blocked' });
    seedLease(db, 'A', 'awb/A-slug');
    releasedParents.add('A');

    await scheduler().onParentReleased('A');
    await scheduler().onParentReleased('A');
    await scheduler().reconcile();

    expect(started.filter((s) => s.taskId === 'B')).toHaveLength(1);
  });

  it('keeps a child blocked if the released parent has no lease branch yet (retries next tick)', async () => {
    upsertTask(db.db, { id: 'A', repositoryId: REPO, prompt: 'A', scheduleState: 'started' });
    upsertTask(db.db, { id: 'B', repositoryId: REPO, prompt: 'B', parentTaskId: 'A', scheduleState: 'blocked' });
    releasedParents.add('A'); // released, but no lease seeded

    await scheduler().onParentReleased('A');
    expect(started).toHaveLength(0);
    expect(getTask(db.db, 'B')?.scheduleState).toBe('blocked');

    // Lease appears → next reconcile starts it.
    seedLease(db, 'A', 'awb/A-slug');
    await scheduler().reconcile();
    expect(started).toEqual([{ taskId: 'B', baseBranch: 'awb/A-slug' }]);
  });

  it('rolls a task back to blocked if starting its workflow fails (retried next tick)', async () => {
    upsertTask(db.db, { id: 'root', repositoryId: REPO, prompt: 'p', scheduleState: 'ready' });
    let fail = true;
    const flaky = new TaskScheduler({
      database: db,
      startTask: async () => {
        if (fail) throw new Error('temporal unavailable');
      },
      hasReleased: async () => false,
    });

    await flaky.reconcile(); // swallows the failure
    // The failed start left the row startable again (not stranded as `started`).
    expect(getTask(db.db, 'root')?.scheduleState).toBe('ready');

    fail = false;
    await flaky.reconcile();
    expect(getTask(db.db, 'root')?.scheduleState).toBe('started');
  });

  it('fan-in (TASK-102): D starts only after BOTH predecessors B and C release', async () => {
    // Diamond: A root; B and C stack on A; D stacks on B and additionally waits on C ('after').
    upsertTask(db.db, { id: 'A', repositoryId: REPO, prompt: 'A', scheduleState: 'started' });
    upsertTask(db.db, { id: 'B', repositoryId: REPO, prompt: 'B', parentTaskId: 'A', scheduleState: 'started' });
    upsertTask(db.db, { id: 'C', repositoryId: REPO, prompt: 'C', parentTaskId: 'A', scheduleState: 'started' });
    upsertTask(db.db, { id: 'D', repositoryId: REPO, prompt: 'D', parentTaskId: 'B', scheduleState: 'blocked' });
    insertTaskDependency(db.db, { taskId: 'D', dependsOnTaskId: 'B', mode: 'stack' });
    insertTaskDependency(db.db, { taskId: 'D', dependsOnTaskId: 'C', mode: 'after' });
    seedLease(db, 'B', 'awb/B-slug');
    seedLease(db, 'C', 'awb/C-slug');

    // Only B releases → D must stay blocked (C hasn't released).
    releasedParents.add('B');
    await scheduler().onParentReleased('B');
    expect(started).toHaveLength(0);
    expect(getTask(db.db, 'D')?.scheduleState).toBe('blocked');

    // C releases → D unblocks, with its base branch from the 'stack' parent B.
    releasedParents.add('C');
    await scheduler().onParentReleased('C');
    expect(started).toEqual([{ taskId: 'D', baseBranch: 'awb/B-slug' }]);
    expect(getTask(db.db, 'D')?.scheduleState).toBe('started');
  });

  it('boot reconcile() re-derives eligibility from SQLite (restart-safety)', async () => {
    // Simulate a restart: A already released + has a lease; B is blocked in the DB. No push arrived.
    upsertTask(db.db, { id: 'A', repositoryId: REPO, prompt: 'A', scheduleState: 'started' });
    upsertTask(db.db, { id: 'B', repositoryId: REPO, prompt: 'B', parentTaskId: 'A', scheduleState: 'blocked' });
    seedLease(db, 'A', 'awb/A-slug');
    releasedParents.add('A');

    await scheduler().reconcile();
    expect(started).toEqual([{ taskId: 'B', baseBranch: 'awb/A-slug' }]);
  });
});
