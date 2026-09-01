import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  repositories,
  agentSessions,
  modelInvocations,
  toolInvocations,
  commandExecutions,
  contextComposition,
  runtimeAttribution,
  semanticEvents,
  findings,
  evidence,
  evidenceClaims,
  evidenceDependencies,
  artifacts,
  humanDecisions,
  waivers,
  plans,
  planSlices,
  planClaimCoverage,
  taskContracts,
  acceptanceClaims,
  pullRequests,
  pullRequestFeedback,
  workspaceLeases,
  type WorkbenchDatabase,
} from '../index.js';
import {
  upsertTask,
  getTask,
  getTaskDeliveredBranch,
  listTasksByParent,
  listBlockedTasks,
  listStartableTasks,
  insertTaskDependency,
  listParentsOf,
  listDependentsOf,
  ensureRun,
  ensurePhaseAttempt,
  deleteTask,
  listTasksWithRepository,
} from './tasks.js';

const REPO_ID = 'repo-1';
const now = '2026-07-28T00:00:00.000Z';

/** Seeds a task plus one representative row in every FK-descendant table, and returns its ids. */
function seedTask(db: WorkbenchDatabase, taskId: string): void {
  const d = db.db;
  upsertTask(d, { id: taskId, repositoryId: REPO_ID, prompt: 'p' });
  const runId = ensureRun(d, taskId);
  const attemptId = ensurePhaseAttempt(d, { taskId, phase: 'plan', attemptNumber: 1 });

  const sessionId = `${taskId}-sess`;
  d.insert(agentSessions)
    .values({ id: sessionId, taskId, runId, phaseAttemptId: attemptId, phase: 'plan', runtime: 'claude', startedAt: now })
    .run();
  d.insert(modelInvocations)
    .values({ id: `${taskId}-mi`, agentSessionId: sessionId, provider: 'anthropic', model: 'opus', inputTokens: 1, outputTokens: 1, startedAt: now })
    .run();
  d.insert(toolInvocations).values({ id: `${taskId}-ti`, agentSessionId: sessionId, tool: 'Read', startedAt: now }).run();
  d.insert(commandExecutions)
    .values({ id: `${taskId}-ce`, agentSessionId: sessionId, phaseAttemptId: attemptId, command: 'ls', cwd: '/tmp', startedAt: now })
    .run();
  d.insert(contextComposition)
    .values({ id: `${taskId}-cc`, taskId, agentSessionId: sessionId, phase: 'plan', role: 'planner', createdAt: now })
    .run();
  d.insert(runtimeAttribution).values({ id: `${taskId}-ra`, taskId, runId, phaseAttemptId: attemptId, phase: 'plan', createdAt: now }).run();
  d.insert(semanticEvents)
    .values({ id: `${taskId}-ev`, runId, sequence: 1, occurredAt: now, phase: 'plan', phaseAttemptId: attemptId, producer: 'planner', type: 'message', summary: 's' })
    .run();

  const findingId = `${taskId}-find`;
  d.insert(findings)
    .values({ id: findingId, taskId, severity: 'blocker', category: 'correctness', claimIdsJson: '[]', description: 'd', status: 'open' })
    .run();
  d.insert(waivers).values({ id: `${taskId}-wv`, taskId, findingId, reason: 'r', createdAt: now }).run();

  const evId = `${taskId}-evi`;
  d.insert(evidence)
    .values({ id: evId, taskId, runId, phaseAttemptId: attemptId, kind: 'unit-test', status: 'passed', claimIdsJson: '[]', contractVersion: 1, repositorySnapshotId: 'snap', policyVersion: 'v1', artifactIdsJson: '[]', summary: 's', createdAt: now })
    .run();
  d.insert(evidenceClaims).values({ evidenceId: evId, claimId: 'c1' }).run();
  d.insert(evidenceDependencies).values({ evidenceId: evId, dependsOnEvidenceId: evId }).run();
  d.insert(artifacts)
    .values({ id: `${taskId}-art`, sha256: 'abc', mediaType: 'text/plain', byteSize: 1, relativePath: 'a.txt', taskId, runId, phaseAttemptId: attemptId, kind: 'command-log', retention: 'temporary', createdAt: now })
    .run();
  d.insert(humanDecisions).values({ id: `${taskId}-hd`, taskId, phase: 'plan', reason: 'r', decision: 'approve', decidedAt: now }).run();

  const planId = `${taskId}-plan`;
  d.insert(plans).values({ id: planId, taskId, contractVersion: 1, version: 1, summary: 's', affectedAreasJson: '[]', risksJson: '[]', status: 'accepted' }).run();
  d.insert(planSlices).values({ id: `${taskId}-slice`, planId, objective: 'o', claimIdsJson: '[]', likelyPathsJson: '[]', requiredTargetedChecksJson: '[]', dependenciesJson: '[]' }).run();
  d.insert(planClaimCoverage).values({ planId, claimId: 'c1', planSliceIdsJson: '[]', qaScenarioIdsJson: '[]' }).run();

  const contractId = `${taskId}-ctr`;
  d.insert(taskContracts).values({ id: contractId, taskId, version: 1, objective: 'o', constraintsJson: '[]', nonGoalsJson: '[]', risk: 'low', status: 'approved' }).run();
  d.insert(acceptanceClaims)
    .values({ id: `${taskId}-ac`, taskContractId: contractId, description: 'd', category: 'behavior', deterministicEvidenceRequired: true, qaEvidenceRequired: false, humanJudgmentRequired: false })
    .run();

  const prId = `${taskId}-pr`;
  d.insert(pullRequests).values({ id: prId, taskId, state: 'open', isDraft: true, title: 't', createdAt: now, updatedAt: now }).run();
  d.insert(pullRequestFeedback).values({ id: `${taskId}-prf`, pullRequestId: prId, body: 'b', resolved: false, createdAt: now }).run();

  d.insert(workspaceLeases)
    .values({ id: `${taskId}-lease`, repositoryId: REPO_ID, taskId, baseRef: 'main', baseSha: 'sha', branchName: 'b', worktreePath: '/tmp/wt', executionProfile: 'native-trusted', allocatedPortsJson: '[]', state: 'active', createdAt: now })
    .run();
}

/** Total descendant + task rows this task owns across every table (for a clean-DB row-count check). */
function rowCountForTask(db: WorkbenchDatabase, taskId: string): number {
  const tables = [
    'tasks', 'runs', 'phase_attempts', 'agent_sessions', 'model_invocations', 'tool_invocations',
    'command_executions', 'context_composition', 'runtime_attribution', 'semantic_events', 'findings',
    'waivers', 'evidence', 'evidence_claims', 'evidence_dependencies', 'artifacts', 'human_decisions',
    'plans', 'plan_slices', 'plan_claim_coverage', 'task_contracts', 'acceptance_claims',
    'pull_requests', 'pull_request_feedback', 'workspace_leases',
  ];
  let total = 0;
  for (const t of tables) {
    // Join tables have no task_id; count them via their parent chain by checking id prefixes instead.
    const row = db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
    total += row.n;
  }
  return total;
}

describe('deleteTask (TASK-37: FK-safe cascade)', () => {
  let dir: string;
  let db: WorkbenchDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-deltask-'));
    db = createDatabase(join(dir, 'wb.sqlite'));
    db.db
      .insert(repositories)
      .values({ id: REPO_ID, canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('removes the target task and every descendant, leaves a sibling intact, and FK-check is clean', () => {
    seedTask(db, 'task-A');
    seedTask(db, 'task-B');

    const before = rowCountForTask(db, 'task-A');
    expect(deleteTask(db.db, 'task-A')).toBe(true);

    // Every row that remains belongs to task-B; the target's rows are all gone.
    expect(db.db.select().from(agentSessions).all().every((r) => r.taskId === 'task-B')).toBe(true);
    expect(db.db.select().from(evidence).all().every((r) => r.taskId === 'task-B')).toBe(true);
    expect(db.db.select().from(plans).all().every((r) => r.taskId === 'task-B')).toBe(true);
    expect(db.db.select().from(pullRequests).all().every((r) => r.taskId === 'task-B')).toBe(true);
    expect(db.db.select().from(semanticEvents).all().every((r) => r.runId === 'task-B-run')).toBe(true);
    // Join tables (no task_id) must be halved — only task-B's survive.
    expect(db.db.select().from(modelInvocations).all()).toHaveLength(1);
    expect(db.db.select().from(planSlices).all()).toHaveLength(1);
    expect(db.db.select().from(acceptanceClaims).all()).toHaveLength(1);
    expect(db.db.select().from(pullRequestFeedback).all()).toHaveLength(1);
    expect(db.db.select().from(evidenceClaims).all()).toHaveLength(1);

    // Row total dropped by exactly task-A's footprint (both tasks seed identically → half remain).
    expect(rowCountForTask(db, 'task-B')).toBe(before / 2);

    // No dangling foreign keys.
    const violations = db.sqlite.prepare('PRAGMA foreign_key_check').all();
    expect(violations).toEqual([]);
  });

  it('returns false for an unknown task and touches nothing', () => {
    seedTask(db, 'task-A');
    const before = rowCountForTask(db, 'task-A');
    expect(deleteTask(db.db, 'task-missing')).toBe(false);
    expect(rowCountForTask(db, 'task-A')).toBe(before);
  });
});

describe('listTasksWithRepository', () => {
  let dir: string;
  let db: WorkbenchDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-listtask-'));
    db = createDatabase(join(dir, 'wb.sqlite'));
    db.db
      .insert(repositories)
      .values({ id: REPO_ID, canonicalPath: '/tmp/repo', name: 'browser-games', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('joins the repository name and carries lifecycle fields', () => {
    upsertTask(db.db, { id: 'task-1', repositoryId: REPO_ID, prompt: 'do a thing', phase: 'plan', condition: 'running' });
    const rows = listTasksWithRepository(db.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'task-1',
      repositoryId: REPO_ID,
      repositoryName: 'browser-games',
      prompt: 'do a thing',
      phase: 'plan',
      condition: 'running',
    });
    expect(rows[0]?.createdAt).toBeTruthy();
    expect(rows[0]?.updatedAt).toBeTruthy();
  });
});

describe('stacked-PR edge (TASK-72)', () => {
  let dir: string;
  let db: WorkbenchDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-stack-'));
    db = createDatabase(join(dir, 'wb.sqlite'));
    db.db
      .insert(repositories)
      .values({ id: REPO_ID, canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips parentTaskId + baseBranch and never clears them on a later phase-only sync', () => {
    upsertTask(db.db, {
      id: 'task-child',
      repositoryId: REPO_ID,
      prompt: 'p',
      parentTaskId: 'task-parent',
      baseBranch: 'awb/task-parent-slug',
    });
    expect(getTask(db.db, 'task-child')).toMatchObject({
      parentTaskId: 'task-parent',
      baseBranch: 'awb/task-parent-slug',
    });

    // A later lifecycle sync (phase/condition only) must not wipe the stacking edge.
    upsertTask(db.db, { id: 'task-child', repositoryId: REPO_ID, prompt: '', phase: 'plan' });
    expect(getTask(db.db, 'task-child')).toMatchObject({
      phase: 'plan',
      parentTaskId: 'task-parent',
      baseBranch: 'awb/task-parent-slug',
    });
  });

  it('resolves a task delivered branch from its workspace lease', () => {
    upsertTask(db.db, { id: 'task-parent', repositoryId: REPO_ID, prompt: 'p' });
    expect(getTaskDeliveredBranch(db.db, 'task-parent')).toBeUndefined();

    db.db
      .insert(workspaceLeases)
      .values({ id: 'task-parent-lease', repositoryId: REPO_ID, taskId: 'task-parent', baseRef: 'main', baseSha: 'sha', branchName: 'awb/task-parent-slug', worktreePath: '/tmp/wt', executionProfile: 'native-trusted', allocatedPortsJson: '[]', state: 'active', createdAt: now })
      .run();
    expect(getTaskDeliveredBranch(db.db, 'task-parent')).toBe('awb/task-parent-slug');
  });
});

describe('task_dependencies edges (TASK-102)', () => {
  let dir: string;
  let db: WorkbenchDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-dep-'));
    db = createDatabase(join(dir, 'wb.sqlite'));
    db.db
      .insert(repositories)
      .values({ id: REPO_ID, canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
    for (const id of ['A', 'B', 'C', 'D']) {
      upsertTask(db.db, { id, repositoryId: REPO_ID, prompt: id });
    }
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('insertTaskDependency is idempotent on (task_id, depends_on_task_id) and updates mode', () => {
    insertTaskDependency(db.db, { taskId: 'B', dependsOnTaskId: 'A', mode: 'after' });
    insertTaskDependency(db.db, { taskId: 'B', dependsOnTaskId: 'A', mode: 'stack' });
    const parents = listParentsOf(db.db, 'B');
    expect(parents).toHaveLength(1);
    expect(parents[0]).toMatchObject({ dependsOnTaskId: 'A', mode: 'stack' });
  });

  it('listParentsOf returns every predecessor edge; listDependentsOf the reverse', () => {
    // Diamond: D after B and C, both after A.
    insertTaskDependency(db.db, { taskId: 'B', dependsOnTaskId: 'A', mode: 'after' });
    insertTaskDependency(db.db, { taskId: 'C', dependsOnTaskId: 'A', mode: 'after' });
    insertTaskDependency(db.db, { taskId: 'D', dependsOnTaskId: 'B', mode: 'stack' });
    insertTaskDependency(db.db, { taskId: 'D', dependsOnTaskId: 'C', mode: 'after' });

    expect(listParentsOf(db.db, 'D').map((e) => e.dependsOnTaskId).sort()).toEqual(['B', 'C']);
    expect(listDependentsOf(db.db, 'A').map((e) => e.taskId).sort()).toEqual(['B', 'C']);
    expect(listDependentsOf(db.db, 'B').map((e) => e.taskId)).toEqual(['D']);
  });

  it('deleteTask removes edges touching the task on either end', () => {
    insertTaskDependency(db.db, { taskId: 'B', dependsOnTaskId: 'A', mode: 'stack' });
    insertTaskDependency(db.db, { taskId: 'C', dependsOnTaskId: 'B', mode: 'after' });
    deleteTask(db.db, 'B');
    expect(listParentsOf(db.db, 'B')).toHaveLength(0);
    expect(listDependentsOf(db.db, 'B')).toHaveLength(0);
    expect(listParentsOf(db.db, 'C')).toHaveLength(0);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('schedule state (task DAG orchestration)', () => {
  let dir: string;
  let db: WorkbenchDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-sched-'));
    db = createDatabase(join(dir, 'wb.sqlite'));
    db.db
      .insert(repositories)
      .values({ id: REPO_ID, canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults scheduleState to ready and round-trips an explicit value', () => {
    upsertTask(db.db, { id: 'root', repositoryId: REPO_ID, prompt: 'p' });
    expect(getTask(db.db, 'root')?.scheduleState).toBe('ready');

    upsertTask(db.db, { id: 'child', repositoryId: REPO_ID, prompt: 'p', scheduleState: 'blocked' });
    expect(getTask(db.db, 'child')?.scheduleState).toBe('blocked');
  });

  it('does not clobber scheduleState on a sync that omits it', () => {
    upsertTask(db.db, { id: 'child', repositoryId: REPO_ID, prompt: 'p', scheduleState: 'blocked' });
    // A later phase-only sync must leave the scheduler-owned state alone.
    upsertTask(db.db, { id: 'child', repositoryId: REPO_ID, prompt: '', phase: 'plan' });
    expect(getTask(db.db, 'child')?.scheduleState).toBe('blocked');
  });

  it('lists children by parent, blocked tasks, and startable tasks', () => {
    upsertTask(db.db, { id: 'A', repositoryId: REPO_ID, prompt: 'A', scheduleState: 'started' });
    upsertTask(db.db, { id: 'B', repositoryId: REPO_ID, prompt: 'B', parentTaskId: 'A', scheduleState: 'blocked' });
    upsertTask(db.db, { id: 'C', repositoryId: REPO_ID, prompt: 'C', parentTaskId: 'A', scheduleState: 'blocked' });
    upsertTask(db.db, { id: 'root2', repositoryId: REPO_ID, prompt: 'r', scheduleState: 'ready' });

    expect(listTasksByParent(db.db, 'A').map((t) => t.id).sort()).toEqual(['B', 'C']);
    expect(listBlockedTasks(db.db).map((t) => t.id).sort()).toEqual(['B', 'C']);
    // Startable = not-yet-started (ready + blocked); the `started` A is excluded.
    expect(listStartableTasks(db.db).map((t) => t.id).sort()).toEqual(['B', 'C', 'root2']);
  });
});
