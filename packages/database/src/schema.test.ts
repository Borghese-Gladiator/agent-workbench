import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDatabase, type WorkbenchDatabase } from './connection.js';
import * as schema from './schema/index.js';

describe('schema round trips', () => {
  let tmpDir: string;
  let handle: WorkbenchDatabase;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'awb-db-'));
    handle = createDatabase(join(tmpDir, 'workbench.sqlite'));
  });

  afterEach(() => {
    handle.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('repositories: insert + select', async () => {
    const { db } = handle;
    await db.insert(schema.repositories).values({
      id: 'repo-1',
      canonicalPath: '/tmp/repo-1',
      name: 'repo-1',
      defaultBranch: 'main',
      trusted: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const rows = await db.select().from(schema.repositories).where(eq(schema.repositories.id, 'repo-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('repo-1');
    expect(rows[0]?.trusted).toBe(true);
  });

  it('tasks: insert + select', async () => {
    const { db } = handle;
    await seedRepository(db);
    await db.insert(schema.tasks).values({
      id: 'task-1',
      repositoryId: 'repo-1',
      prompt: 'do the thing',
      phase: 'plan',
      condition: 'running',
      deliveryState: 'not-started',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'task-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phase).toBe('plan');
  });

  it('evidence: insert + select', async () => {
    const { db } = handle;
    await seedTaskGraph(db);
    await db.insert(schema.evidence).values({
      id: 'evidence-1',
      taskId: 'task-1',
      runId: 'run-1',
      phaseAttemptId: 'phase-attempt-1',
      kind: 'unit-test',
      status: 'passed',
      claimIdsJson: '[]',
      contractVersion: 1,
      repositorySnapshotId: 'snapshot-1',
      policyVersion: 'v1',
      artifactIdsJson: '[]',
      summary: 'unit tests passed',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const rows = await db.select().from(schema.evidence).where(eq(schema.evidence.id, 'evidence-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('passed');
  });

  it('findings: insert + select', async () => {
    const { db } = handle;
    await seedTaskGraph(db);
    await db.insert(schema.findings).values({
      id: 'finding-1',
      taskId: 'task-1',
      severity: 'high',
      category: 'correctness',
      claimIdsJson: '[]',
      description: 'off by one error',
      status: 'open',
    });

    const rows = await db.select().from(schema.findings).where(eq(schema.findings.id, 'finding-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.severity).toBe('high');
  });

  it('semantic_events: insert + select', async () => {
    const { db } = handle;
    await seedTaskGraph(db);
    await db.insert(schema.semanticEvents).values({
      id: 'event-1',
      runId: 'run-1',
      sequence: 0,
      occurredAt: '2026-01-01T00:00:00Z',
      phase: 'implement',
      phaseAttemptId: 'phase-attempt-1',
      producer: 'builder',
      type: 'message',
      summary: 'started work',
    });

    const rows = await db
      .select()
      .from(schema.semanticEvents)
      .where(eq(schema.semanticEvents.id, 'event-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.producer).toBe('builder');
  });

  it('memory_entries: insert + select', async () => {
    const { db } = handle;
    await seedRepository(db);
    await db.insert(schema.memoryEntries).values({
      id: 'memory-1',
      repositoryId: 'repo-1',
      title: 'gotcha',
      body: 'watch out for X',
      kind: 'pitfall',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const rows = await db
      .select()
      .from(schema.memoryEntries)
      .where(eq(schema.memoryEntries.id, 'memory-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('gotcha');
  });

  it('every remaining table in the spec: minimal insert + select', async () => {
    const { db } = handle;
    await seedTaskGraph(db);

    expect(
      (await db.select().from(schema.repositorySnapshots).where(eq(schema.repositorySnapshots.id, 'snapshot-1')))
        .length,
    ).toBe(1);

    await db.insert(schema.repositoryUnits).values({
      id: 'unit-1',
      repositoryId: 'repo-1',
      root: '.',
      language: 'typescript',
      kind: 'library',
      dependsOnJson: '[]',
    });
    expect(
      (await db.select().from(schema.repositoryUnits).where(eq(schema.repositoryUnits.id, 'unit-1'))).length,
    ).toBe(1);

    await db.insert(schema.repositoryCommands).values({
      id: 'command-1',
      repositoryId: 'repo-1',
      unitId: 'unit-1',
      purpose: 'unit-test',
      command: 'pnpm test',
      cwd: '.',
      source: 'package-script',
      status: 'declared',
    });
    expect(
      (await db.select().from(schema.repositoryCommands).where(eq(schema.repositoryCommands.id, 'command-1')))
        .length,
    ).toBe(1);

    await db.insert(schema.repositoryServices).values({
      id: 'service-1',
      repositoryId: 'repo-1',
      unitId: 'unit-1',
      name: 'api',
      kind: 'http-api',
      startCommandId: 'command-1',
    });
    expect(
      (await db.select().from(schema.repositoryServices).where(eq(schema.repositoryServices.id, 'service-1')))
        .length,
    ).toBe(1);

    await db.insert(schema.repositoryQaSurfaces).values({
      id: 'qa-surface-1',
      repositoryId: 'repo-1',
      unitId: 'unit-1',
      kind: 'http-api',
      entrypoint: '/health',
    });
    expect(
      (
        await db
          .select()
          .from(schema.repositoryQaSurfaces)
          .where(eq(schema.repositoryQaSurfaces.id, 'qa-surface-1'))
      ).length,
    ).toBe(1);

    await db.insert(schema.repositoryFacts).values({
      id: 'fact-1',
      repositoryId: 'repo-1',
      kind: 'convention',
      statement: 'uses drizzle orm',
      confidence: 'validated',
      observedAtSha: 'abc123',
      sourcePathsJson: '[]',
      sourceHashesJson: '[]',
      invalidatedByPathsJson: '[]',
    });
    expect(
      (await db.select().from(schema.repositoryFacts).where(eq(schema.repositoryFacts.id, 'fact-1'))).length,
    ).toBe(1);

    await db.insert(schema.repositoryFactSources).values({
      factId: 'fact-1',
      path: 'src/schema/index.ts',
    });
    expect(
      (
        await db
          .select()
          .from(schema.repositoryFactSources)
          .where(eq(schema.repositoryFactSources.factId, 'fact-1'))
      ).length,
    ).toBe(1);

    await db.insert(schema.repositorySymbols).values({
      id: 'symbol-1',
      repositoryId: 'repo-1',
      snapshotId: 'snapshot-1',
      path: 'src/index.ts',
      name: 'createDatabase',
      kind: 'function',
    });
    expect(
      (await db.select().from(schema.repositorySymbols).where(eq(schema.repositorySymbols.id, 'symbol-1'))).length,
    ).toBe(1);

    await db.insert(schema.repositoryUnits).values({
      id: 'unit-2',
      repositoryId: 'repo-1',
      root: 'src/other',
      language: 'typescript',
      kind: 'library',
      dependsOnJson: '[]',
    });
    await db.insert(schema.repositoryDependencies).values({
      repositoryId: 'repo-1',
      fromUnitId: 'unit-1',
      toUnitId: 'unit-2',
      kind: 'imports',
    });
    expect(
      (
        await db
          .select()
          .from(schema.repositoryDependencies)
          .where(eq(schema.repositoryDependencies.fromUnitId, 'unit-1'))
      ).length,
    ).toBe(1);

    await db.insert(schema.taskContracts).values({
      id: 'contract-1',
      taskId: 'task-1',
      version: 1,
      objective: 'ship the feature',
      constraintsJson: '[]',
      nonGoalsJson: '[]',
      risk: 'low',
      status: 'draft',
    });
    expect(
      (await db.select().from(schema.taskContracts).where(eq(schema.taskContracts.id, 'contract-1'))).length,
    ).toBe(1);

    await db.insert(schema.acceptanceClaims).values({
      id: 'claim-1',
      taskContractId: 'contract-1',
      description: 'feature works',
      category: 'behavior',
      deterministicEvidenceRequired: true,
      qaEvidenceRequired: false,
      humanJudgmentRequired: false,
    });
    expect(
      (await db.select().from(schema.acceptanceClaims).where(eq(schema.acceptanceClaims.id, 'claim-1'))).length,
    ).toBe(1);

    await db.insert(schema.plans).values({
      id: 'plan-1',
      taskId: 'task-1',
      contractVersion: 1,
      version: 1,
      summary: 'plan summary',
      affectedAreasJson: '[]',
      risksJson: '[]',
      status: 'draft',
    });
    expect((await db.select().from(schema.plans).where(eq(schema.plans.id, 'plan-1'))).length).toBe(1);

    await db.insert(schema.planSlices).values({
      id: 'slice-1',
      planId: 'plan-1',
      objective: 'slice objective',
      claimIdsJson: '[]',
      likelyPathsJson: '[]',
      requiredTargetedChecksJson: '[]',
      dependenciesJson: '[]',
    });
    expect((await db.select().from(schema.planSlices).where(eq(schema.planSlices.id, 'slice-1'))).length).toBe(1);

    await db.insert(schema.planClaimCoverage).values({
      planId: 'plan-1',
      claimId: 'claim-1',
      planSliceIdsJson: '["slice-1"]',
      qaScenarioIdsJson: '[]',
    });
    expect(
      (await db.select().from(schema.planClaimCoverage).where(eq(schema.planClaimCoverage.planId, 'plan-1'))).length,
    ).toBe(1);

    expect((await db.select().from(schema.runs).where(eq(schema.runs.id, 'run-1'))).length).toBe(1);
    expect(
      (await db.select().from(schema.phaseAttempts).where(eq(schema.phaseAttempts.id, 'phase-attempt-1'))).length,
    ).toBe(1);

    await db.insert(schema.workspaceLeases).values({
      id: 'lease-1',
      repositoryId: 'repo-1',
      taskId: 'task-1',
      baseRef: 'main',
      baseSha: 'abc123',
      branchName: 'awb/task-1',
      worktreePath: '/tmp/worktree-1',
      executionProfile: 'native-trusted',
      allocatedPortsJson: '{}',
      state: 'ready',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(
      (await db.select().from(schema.workspaceLeases).where(eq(schema.workspaceLeases.id, 'lease-1'))).length,
    ).toBe(1);

    expect(
      (await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, 'session-1'))).length,
    ).toBe(1);

    await db.insert(schema.modelInvocations).values({
      id: 'model-invocation-1',
      agentSessionId: 'session-1',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
      startedAt: '2026-01-01T00:00:00Z',
    });
    expect(
      (
        await db
          .select()
          .from(schema.modelInvocations)
          .where(eq(schema.modelInvocations.id, 'model-invocation-1'))
      ).length,
    ).toBe(1);

    await db.insert(schema.toolInvocations).values({
      id: 'tool-invocation-1',
      agentSessionId: 'session-1',
      tool: 'Edit',
      startedAt: '2026-01-01T00:00:00Z',
    });
    expect(
      (await db.select().from(schema.toolInvocations).where(eq(schema.toolInvocations.id, 'tool-invocation-1')))
        .length,
    ).toBe(1);

    await db.insert(schema.commandExecutions).values({
      id: 'command-execution-1',
      agentSessionId: 'session-1',
      phaseAttemptId: 'phase-attempt-1',
      command: 'pnpm test',
      cwd: '.',
      startedAt: '2026-01-01T00:00:00Z',
    });
    expect(
      (await db.select().from(schema.commandExecutions).where(eq(schema.commandExecutions.id, 'command-execution-1')))
        .length,
    ).toBe(1);

    await db.insert(schema.findings).values({
      id: 'finding-waiver-target',
      taskId: 'task-1',
      severity: 'low',
      category: 'maintainability',
      claimIdsJson: '[]',
      description: 'minor nit',
      status: 'open',
    });
    await db.insert(schema.evidence).values({
      id: 'evidence-dep-source',
      taskId: 'task-1',
      runId: 'run-1',
      phaseAttemptId: 'phase-attempt-1',
      kind: 'build',
      status: 'passed',
      claimIdsJson: '[]',
      contractVersion: 1,
      repositorySnapshotId: 'snapshot-1',
      policyVersion: 'v1',
      artifactIdsJson: '[]',
      summary: 'build passed',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await db.insert(schema.evidence).values({
      id: 'evidence-dep-target',
      taskId: 'task-1',
      runId: 'run-1',
      phaseAttemptId: 'phase-attempt-1',
      kind: 'unit-test',
      status: 'passed',
      claimIdsJson: '[]',
      contractVersion: 1,
      repositorySnapshotId: 'snapshot-1',
      policyVersion: 'v1',
      artifactIdsJson: '[]',
      summary: 'unit test passed',
      createdAt: '2026-01-01T00:00:00Z',
    });

    await db.insert(schema.evidenceClaims).values({
      evidenceId: 'evidence-dep-target',
      claimId: 'claim-1',
    });
    expect(
      (
        await db
          .select()
          .from(schema.evidenceClaims)
          .where(eq(schema.evidenceClaims.evidenceId, 'evidence-dep-target'))
      ).length,
    ).toBe(1);

    await db.insert(schema.evidenceDependencies).values({
      evidenceId: 'evidence-dep-target',
      dependsOnEvidenceId: 'evidence-dep-source',
    });
    expect(
      (
        await db
          .select()
          .from(schema.evidenceDependencies)
          .where(eq(schema.evidenceDependencies.evidenceId, 'evidence-dep-target'))
      ).length,
    ).toBe(1);

    await db.insert(schema.artifacts).values({
      id: 'artifact-1',
      sha256: 'deadbeef',
      mediaType: 'text/plain',
      byteSize: 42,
      relativePath: 'artifacts/artifact-1.txt',
      taskId: 'task-1',
      kind: 'command-log',
      retention: 'task',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect((await db.select().from(schema.artifacts).where(eq(schema.artifacts.id, 'artifact-1'))).length).toBe(1);

    await db.insert(schema.humanDecisions).values({
      id: 'human-decision-1',
      taskId: 'task-1',
      phase: 'plan',
      reason: 'task-contract-approval',
      decision: 'approved',
      decidedAt: '2026-01-01T00:00:00Z',
    });
    expect(
      (await db.select().from(schema.humanDecisions).where(eq(schema.humanDecisions.id, 'human-decision-1'))).length,
    ).toBe(1);

    await db.insert(schema.waivers).values({
      id: 'waiver-1',
      taskId: 'task-1',
      findingId: 'finding-waiver-target',
      reason: 'acceptable risk',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect((await db.select().from(schema.waivers).where(eq(schema.waivers.id, 'waiver-1'))).length).toBe(1);

    await db.insert(schema.pullRequests).values({
      id: 'pr-1',
      taskId: 'task-1',
      state: 'open',
      isDraft: true,
      title: 'Add database package',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect((await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, 'pr-1'))).length).toBe(1);

    await db.insert(schema.pullRequestFeedback).values({
      id: 'pr-feedback-1',
      pullRequestId: 'pr-1',
      body: 'looks good',
      resolved: false,
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(
      (
        await db
          .select()
          .from(schema.pullRequestFeedback)
          .where(eq(schema.pullRequestFeedback.id, 'pr-feedback-1'))
      ).length,
    ).toBe(1);

    await db.insert(schema.memoryEntries).values({
      id: 'memory-2',
      repositoryId: 'repo-1',
      title: 'another memory',
      body: 'body text',
      kind: 'convention',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    await db.insert(schema.memorySources).values({
      id: 'memory-source-1',
      memoryEntryId: 'memory-2',
      path: 'src/index.ts',
    });
    expect(
      (await db.select().from(schema.memorySources).where(eq(schema.memorySources.id, 'memory-source-1'))).length,
    ).toBe(1);

    await db.insert(schema.failureSignatures).values({
      id: 'failure-signature-1',
      repositoryId: 'repo-1',
      signature: 'TypeError: x is not a function',
      summary: 'flaky test failure',
      occurrenceCount: 3,
      firstSeenAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-01-02T00:00:00Z',
    });
    expect(
      (
        await db
          .select()
          .from(schema.failureSignatures)
          .where(eq(schema.failureSignatures.id, 'failure-signature-1'))
      ).length,
    ).toBe(1);
  });
});

async function seedRepository(db: WorkbenchDatabase['db']): Promise<void> {
  await db.insert(schema.repositories).values({
    id: 'repo-1',
    canonicalPath: '/tmp/repo-1',
    name: 'repo-1',
    defaultBranch: 'main',
    trusted: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
}

async function seedTaskGraph(db: WorkbenchDatabase['db']): Promise<void> {
  await seedRepository(db);
  await db.insert(schema.tasks).values({
    id: 'task-1',
    repositoryId: 'repo-1',
    prompt: 'do the thing',
    phase: 'implement',
    condition: 'running',
    deliveryState: 'not-started',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  await db.insert(schema.runs).values({
    id: 'run-1',
    taskId: 'task-1',
    createdAt: '2026-01-01T00:00:00Z',
  });
  await db.insert(schema.phaseAttempts).values({
    id: 'phase-attempt-1',
    runId: 'run-1',
    taskId: 'task-1',
    phase: 'implement',
    attemptNumber: 1,
    startedAt: '2026-01-01T00:00:00Z',
  });
  await db.insert(schema.repositorySnapshots).values({
    id: 'snapshot-1',
    repositoryId: 'repo-1',
    headSha: 'abc123',
    createdAt: '2026-01-01T00:00:00Z',
  });
  await db.insert(schema.agentSessions).values({
    id: 'session-1',
    taskId: 'task-1',
    runId: 'run-1',
    phaseAttemptId: 'phase-attempt-1',
    phase: 'implement',
    runtime: 'claude',
    startedAt: '2026-01-01T00:00:00Z',
  });
}
