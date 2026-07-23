import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDataDir } from '@awb/config';
import {
  createDatabase,
  repositories,
  upsertTask,
  persistRunStateSnapshot,
  type WorkbenchDatabase,
} from '@awb/database';
import type { RunStateSnapshot, TaskContract } from '@awb/domain';
import { SqliteRunStateStore, toSnapshot } from './sqlite-run-state-store.js';
import type { DaemonClient } from '../daemon-client.js';
import type { TaskRunState } from './run-state-store.js';

const REPO_ID = 'repo-1';
const TASK_ID = 'task-1';

/** A DaemonClient that writes straight to the test DB, standing in for the daemon's internal routes. */
function fakeDaemonClient(database: WorkbenchDatabase): DaemonClient {
  return {
    async upsertTask(input) {
      upsertTask(database.db, {
        id: input.taskId,
        repositoryId: input.repositoryId,
        prompt: input.prompt,
      });
    },
    async saveRunState(snapshot: RunStateSnapshot) {
      upsertTask(database.db, {
        id: snapshot.taskId,
        repositoryId: snapshot.repositoryId,
        prompt: snapshot.prompt ?? '',
      });
      persistRunStateSnapshot(database.db, snapshot);
    },
    async postEvent() {
      /* not exercised here */
    },
  };
}

const sampleContract = (): TaskContract => ({
  id: 'contract-1',
  taskId: TASK_ID,
  version: 1,
  objective: 'Add a feature',
  constraints: ['keep tests green'],
  nonGoals: [],
  risk: 'low',
  claims: [
    {
      id: 'claim-1',
      description: 'works',
      category: 'behavior',
      deterministicEvidenceRequired: true,
      qaEvidenceRequired: false,
      humanJudgmentRequired: false,
    },
  ],
  status: 'approved',
});

describe('SqliteRunStateStore (TASK-27 worker-restart recovery)', () => {
  let dataDir: string;
  let database: WorkbenchDatabase;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'awb-sqlite-store-'));
    process.env.AWB_DATA_DIR = dataDir;
    const { layout } = initDataDir();
    database = createDatabase(layout.workbenchSqlite);
    const now = new Date().toISOString();
    database.db
      .insert(repositories)
      .values({
        id: REPO_ID,
        canonicalPath: '/tmp/repo',
        name: 'repo',
        remoteUrl: null,
        defaultBranch: 'main',
        trusted: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    upsertTask(database.db, { id: TASK_ID, repositoryId: REPO_ID, prompt: 'do it' });
  });

  afterEach(async () => {
    database.close();
    delete process.env.AWB_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('resumes a mid-task state after a simulated worker restart', async () => {
    // First "worker process" saves an in-flight state.
    const store1 = new SqliteRunStateStore(fakeDaemonClient(database));
    const state = await store1.load(TASK_ID);
    state.repositoryId = REPO_ID;
    state.contract = sampleContract();
    // baseSha + worktreePath are carried on the lease (prepare creates it); candidateSha rides
    // evidence — this mirrors how the real pipeline populates the run state.
    state.lease = {
      id: 'lease-1',
      repositoryId: REPO_ID,
      taskId: TASK_ID,
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      branchName: 'awb/task-1',
      worktreePath: '/tmp/worktree',
      executionProfile: 'native-trusted',
      allocatedPorts: {},
      state: 'ready',
      createdAt: new Date().toISOString(),
    };
    state.baseSha = 'a'.repeat(40);
    state.candidateSha = 'b'.repeat(40);
    state.worktreePath = '/tmp/worktree';
    state.verificationEvidence.push({
      id: 'ev-1',
      taskId: TASK_ID,
      runId: `${TASK_ID}-run`,
      phaseAttemptId: `${TASK_ID}-verify-1`,
      kind: 'unit-test',
      status: 'passed',
      claimIds: ['claim-1'],
      contractVersion: 1,
      repositorySnapshotId: 'snap-1',
      candidateSha: 'b'.repeat(40),
      policyVersion: 'v1',
      artifactIds: [],
      summary: 'green',
      createdAt: new Date().toISOString(),
    });
    await store1.save(TASK_ID, state);

    // Second "worker process": a fresh store with an empty cache reads the persisted state back.
    const store2 = new SqliteRunStateStore(fakeDaemonClient(database));
    const resumed = await store2.load(TASK_ID);

    expect(resumed.contract).toEqual(sampleContract());
    expect(resumed.candidateSha).toBe('b'.repeat(40));
    expect(resumed.baseSha).toBe('a'.repeat(40));
    expect(resumed.verificationEvidence).toHaveLength(1);
    expect(resumed.verificationEvidence[0]?.id).toBe('ev-1');
    // The ArtifactStore is reconstructed pointing at the durable artifacts dir.
    expect(resumed.artifactsDir).toBe(initDataDir().layout.artifactsDir);
  });

  it('load returns a fresh empty state for an unknown task', async () => {
    const store = new SqliteRunStateStore(fakeDaemonClient(database));
    const state = await store.load('never-persisted');
    expect(state.contract).toBeUndefined();
    expect(state.verificationEvidence).toEqual([]);
    expect(state.artifactStore).toBeDefined();
  });

  it('toSnapshot captures artifact metadata from the ArtifactStore', async () => {
    const store = new SqliteRunStateStore(fakeDaemonClient(database));
    const state: TaskRunState = await store.load(TASK_ID);
    state.repositoryId = REPO_ID;
    await state.artifactStore.put({
      source: Buffer.from('hello'),
      mediaType: 'text/plain',
      kind: 'command-log',
      retention: 'task',
      taskId: TASK_ID,
    });
    const snapshot = toSnapshot(TASK_ID, state);
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0]?.kind).toBe('command-log');
  });
});
