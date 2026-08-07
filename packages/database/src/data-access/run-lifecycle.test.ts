import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  TaskContract,
  ImplementationPlan,
  Evidence,
  Finding,
  WorkspaceLease,
  ArtifactRecord,
} from '@awb/domain';
import {
  createDatabase,
  createReadOnlyDatabase,
  repositories,
  type WorkbenchDatabase,
} from '../index.js';
import {
  upsertTask,
  getTask,
  listTasks,
  ensureRun,
  ensurePhaseAttempt,
  upsertContract,
  getContract,
  upsertPlan,
  getPlan,
  insertEvidence,
  getEvidence,
  listEvidenceByTask,
  insertFinding,
  listFindingsByTask,
  upsertWorkspaceLease,
  getWorkspaceLease,
  insertArtifact,
  getArtifact,
  getArtifactBySha256,
  listArtifactsByTask,
  persistRunStateSnapshot,
  loadRunStateSnapshot,
} from '../index.js';
import type { RunStateSnapshot } from '@awb/domain';

const REPO_ID = 'repo-1';
const TASK_ID = 'task-1';

function seedRepoAndTask(db: WorkbenchDatabase): void {
  const now = new Date().toISOString();
  db.db
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
  upsertTask(db.db, { id: TASK_ID, repositoryId: REPO_ID, prompt: 'do the thing' });
}

const sampleContract = (): TaskContract => ({
  id: 'contract-1',
  taskId: TASK_ID,
  version: 1,
  objective: 'Add a feature',
  problemStatement: 'The button does not exist yet',
  constraints: ['no new deps', 'keep tests green'],
  nonGoals: ['no refactor'],
  risk: 'medium',
  claims: [
    {
      id: 'claim-1',
      description: 'button works',
      category: 'behavior',
      deterministicEvidenceRequired: true,
      qaEvidenceRequired: true,
      humanJudgmentRequired: false,
    },
  ],
  status: 'approved',
});

const samplePlan = (): ImplementationPlan => ({
  id: 'plan-1',
  taskId: TASK_ID,
  contractVersion: 1,
  version: 1,
  summary: 'one slice',
  affectedAreas: ['src/'],
  slices: [
    {
      id: 'slice-1',
      objective: 'wire the button',
      claimIds: ['claim-1'],
      likelyPaths: ['src/Button.tsx'],
      requiredTargetedChecks: ['unit'],
      dependencies: [],
      qaScenarioIds: ['scenario-1'],
    },
  ],
  risks: [{ id: 'risk-1', description: 'flaky', severity: 'low', mitigation: 'retry' }],
  claimCoverage: [{ claimId: 'claim-1', planSliceIds: ['slice-1'], qaScenarioIds: ['scenario-1'] }],
  status: 'accepted',
});

describe('run-lifecycle data-access', () => {
  let dbDir: string;
  let database: WorkbenchDatabase;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-runstate-db-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    seedRepoAndTask(database);
  });

  afterEach(async () => {
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('round-trips a TaskContract with claims', () => {
    const contract = sampleContract();
    upsertContract(database.db, contract);
    expect(getContract(database.db, contract.id)).toEqual(contract);
  });

  it('upsertContract is idempotent and replaces claims', () => {
    upsertContract(database.db, sampleContract());
    const updated = { ...sampleContract(), objective: 'Changed', claims: [] };
    upsertContract(database.db, updated);
    expect(getContract(database.db, 'contract-1')).toEqual(updated);
  });

  it('round-trips an ImplementationPlan with slices + claim coverage', () => {
    const plan = samplePlan();
    upsertPlan(database.db, plan);
    expect(getPlan(database.db, plan.id)).toEqual(plan);
  });

  it('round-trips Evidence (with FK run + phase attempt) and lists by task', () => {
    const runId = ensureRun(database.db, TASK_ID);
    const phaseAttemptId = ensurePhaseAttempt(database.db, {
      taskId: TASK_ID,
      phase: 'verify',
      attemptNumber: 1,
    });
    const evidence: Evidence = {
      id: 'ev-1',
      taskId: TASK_ID,
      runId,
      phaseAttemptId,
      kind: 'unit-test',
      status: 'passed',
      claimIds: ['claim-1'],
      contractVersion: 1,
      planVersion: 1,
      repositorySnapshotId: 'snap-1',
      baseSha: 'a'.repeat(40),
      candidateSha: 'b'.repeat(40),
      environmentDigest: 'env-abc',
      policyVersion: 'v1',
      artifactIds: ['art-1'],
      summary: 'all green',
      createdAt: new Date().toISOString(),
    };
    insertEvidence(database.db, evidence);
    expect(getEvidence(database.db, 'ev-1')).toEqual(evidence);
    expect(listEvidenceByTask(database.db, TASK_ID)).toEqual([evidence]);
  });

  it('round-trips a Finding and lists by task', () => {
    const finding: Finding = {
      id: 'find-1',
      taskId: TASK_ID,
      candidateSha: 'b'.repeat(40),
      severity: 'high',
      category: 'correctness',
      claimIds: ['claim-1'],
      path: 'src/Button.tsx',
      line: 42,
      description: 'off by one',
      reproduction: ['click', 'observe'],
      proposedRemediation: 'fix the loop',
      status: 'open',
    };
    insertFinding(database.db, finding);
    expect(listFindingsByTask(database.db, TASK_ID)).toEqual([finding]);
  });

  it('round-trips a WorkspaceLease', () => {
    const lease: WorkspaceLease = {
      id: 'lease-1',
      repositoryId: REPO_ID,
      taskId: TASK_ID,
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      branchName: 'awb/task-1',
      worktreePath: '/tmp/worktree',
      executionProfile: 'native-trusted',
      allocatedPorts: { web: 5173 },
      state: 'ready',
      createdAt: new Date().toISOString(),
    };
    upsertWorkspaceLease(database.db, lease);
    expect(getWorkspaceLease(database.db, 'lease-1')).toEqual(lease);
  });

  it('round-trips an ArtifactRecord and finds by sha + task', () => {
    const record: ArtifactRecord = {
      id: 'art-1',
      sha256: 'c'.repeat(64),
      mediaType: 'video/webm',
      byteSize: 1234,
      relativePath: 'sha256/cc/' + 'c'.repeat(64),
      taskId: TASK_ID,
      candidateSha: 'b'.repeat(40),
      kind: 'qa-video',
      retention: 'task',
      createdAt: new Date().toISOString(),
    };
    insertArtifact(database.db, record);
    expect(getArtifact(database.db, 'art-1')).toEqual(record);
    expect(getArtifactBySha256(database.db, record.sha256)).toEqual(record);
    expect(listArtifactsByTask(database.db, TASK_ID)).toEqual([record]);
  });

  it('persists and reloads a full RunStateSnapshot (worker-restart recovery)', () => {
    const snapshot: RunStateSnapshot = {
      taskId: TASK_ID,
      repositoryId: REPO_ID,
      prompt: 'do the thing',
      contract: sampleContract(),
      plan: samplePlan(),
      baseSha: 'a'.repeat(40),
      candidateSha: 'b'.repeat(40),
      worktreePath: '/tmp/worktree',
      lease: {
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
      },
      verificationEvidence: [
        {
          id: 'ev-1',
          taskId: TASK_ID,
          runId: `${TASK_ID}-run`,
          phaseAttemptId: `${TASK_ID}-verify-1`,
          kind: 'unit-test',
          status: 'passed',
          claimIds: ['claim-1'],
          contractVersion: 1,
          planVersion: 1,
          repositorySnapshotId: 'snap-1',
          baseSha: 'a'.repeat(40),
          candidateSha: 'b'.repeat(40),
          policyVersion: 'v1',
          artifactIds: [],
          summary: 'green',
          createdAt: new Date().toISOString(),
        },
      ],
      qaEvidence: [
        {
          id: 'ev-2',
          taskId: TASK_ID,
          runId: `${TASK_ID}-run`,
          phaseAttemptId: `${TASK_ID}-exercise-1`,
          kind: 'qa-video',
          status: 'passed',
          claimIds: ['claim-1'],
          contractVersion: 1,
          planVersion: 1,
          repositorySnapshotId: 'snap-1',
          candidateSha: 'b'.repeat(40),
          policyVersion: 'v1',
          artifactIds: ['art-1'],
          summary: 'video',
          createdAt: new Date().toISOString(),
        },
      ],
      reviewFindings: [
        {
          id: 'find-1',
          taskId: TASK_ID,
          candidateSha: 'b'.repeat(40),
          severity: 'low',
          category: 'maintainability',
          claimIds: [],
          description: 'nit',
          status: 'open',
        },
      ],
      artifacts: [
        {
          id: 'art-1',
          sha256: 'c'.repeat(64),
          mediaType: 'video/webm',
          byteSize: 100,
          relativePath: 'sha256/cc/' + 'c'.repeat(64),
          taskId: TASK_ID,
          candidateSha: 'b'.repeat(40),
          kind: 'qa-video',
          retention: 'task',
          createdAt: new Date().toISOString(),
        },
      ],
    };

    persistRunStateSnapshot(database.db, snapshot);

    const reloaded = loadRunStateSnapshot(database.db, {
      taskId: TASK_ID,
      repositoryId: REPO_ID,
      prompt: 'do the thing',
    });

    expect(reloaded.contract).toEqual(snapshot.contract);
    expect(reloaded.plan).toEqual(snapshot.plan);
    expect(reloaded.lease).toEqual(snapshot.lease);
    expect(reloaded.candidateSha).toBe('b'.repeat(40));
    expect(reloaded.verificationEvidence).toEqual(snapshot.verificationEvidence);
    expect(reloaded.qaEvidence).toEqual(snapshot.qaEvidence);
    expect(reloaded.reviewFindings).toEqual(snapshot.reviewFindings);
    expect(reloaded.artifacts).toEqual(snapshot.artifacts);
  });

  it('persists a plan-phase snapshot whose artifact has run/attempt ids but no evidence', () => {
    // Regression: the plan phase writes an artifact carrying runId + phaseAttemptId, but no
    // verification/QA evidence exists yet. Artifacts FK to runs/phase_attempts, and the parents were
    // previously ensured only in the evidence loop — so this snapshot failed with a FOREIGN KEY error.
    const snapshot: RunStateSnapshot = {
      taskId: TASK_ID,
      repositoryId: REPO_ID,
      prompt: 'do the thing',
      contract: sampleContract(),
      plan: samplePlan(),
      verificationEvidence: [],
      qaEvidence: [],
      reviewFindings: [],
      artifacts: [
        {
          id: 'plan-art-1',
          sha256: 'd'.repeat(64),
          mediaType: 'text/markdown',
          byteSize: 512,
          relativePath: 'sha256/dd/' + 'd'.repeat(64),
          taskId: TASK_ID,
          runId: `${TASK_ID}-run`,
          phaseAttemptId: `${TASK_ID}-plan-1`,
          kind: 'agent-output',
          retention: 'task',
          createdAt: new Date().toISOString(),
        },
      ],
    };

    expect(() => persistRunStateSnapshot(database.db, snapshot)).not.toThrow();
    expect(listArtifactsByTask(database.db, TASK_ID)).toHaveLength(1);
  });

  it('upsertTask persists phase/condition/delivery updates', () => {
    expect(getTask(database.db, TASK_ID)?.phase).toBe('specify');
    upsertTask(database.db, {
      id: TASK_ID,
      repositoryId: REPO_ID,
      prompt: 'do the thing',
      phase: 'verify',
      condition: 'running',
      deliveryState: 'branch-ready',
    });
    const row = getTask(database.db, TASK_ID);
    expect(row?.phase).toBe('verify');
    expect(row?.deliveryState).toBe('branch-ready');
    expect(listTasks(database.db)).toHaveLength(1);
  });
});

describe('createReadOnlyDatabase (single-writer invariant, TASK-21)', () => {
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-readonly-db-'));
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true, force: true });
  });

  it('can read a migrated DB but rejects writes', () => {
    const path = join(dbDir, 'workbench.sqlite');
    const writable = createDatabase(path);
    const now = new Date().toISOString();
    writable.db
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
    writable.close();

    const readonly = createReadOnlyDatabase(path);
    try {
      // Reads work.
      expect(readonly.db.select().from(repositories).all()).toHaveLength(1);
      // Writes are rejected at the SQLite layer.
      expect(() =>
        readonly.db
          .insert(repositories)
          .values({
            id: 'repo-2',
            canonicalPath: '/tmp/repo2',
            name: 'repo2',
            remoteUrl: null,
            defaultBranch: 'main',
            trusted: true,
            createdAt: now,
            updatedAt: now,
          })
          .run(),
      ).toThrow(/readonly|read-only|read only/i);
    } finally {
      readonly.close();
    }
  });
});
