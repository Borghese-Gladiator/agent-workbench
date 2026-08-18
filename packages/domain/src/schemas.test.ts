import { describe, expect, it } from 'vitest';
import {
  RepositorySchema,
  RepositorySnapshotSchema,
  ValidatedCommandSchema,
  RepositoryFactSchema,
  TaskContractSchema,
  AcceptanceClaimSchema,
  ImplementationPlanSchema,
  PlanSliceSchema,
  TaskSchema,
  WorkspaceLeaseSchema,
  EvidenceSchema,
  FindingSchema,
  ArtifactRecordSchema,
  SemanticEventSchema,
  PhaseAttemptResultSchema,
  CompletionCandidateSchema,
} from './index.js';

describe('domain schemas', () => {
  it('parses a minimal valid Repository', () => {
    const repo = RepositorySchema.parse({
      id: 'repo-1',
      canonicalPath: '/tmp/repo',
      name: 'repo',
      defaultBranch: 'main',
      trusted: false,
      isEnterpriseRepo: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(repo.trusted).toBe(false);
    expect(repo.isEnterpriseRepo).toBe(false);
  });

  it('rejects a Repository missing required fields', () => {
    expect(() => RepositorySchema.parse({ id: 'repo-1' })).toThrow();
  });

  it('parses a RepositorySnapshot with nested arrays', () => {
    const snapshot = RepositorySnapshotSchema.parse({
      id: 'snap-1',
      repositoryId: 'repo-1',
      headSha: 'abc123',
      createdAt: new Date().toISOString(),
      units: [],
      commands: [],
      services: [],
      qaSurfaces: [],
      facts: [],
      hasExistingFrontend: false,
    });
    expect(snapshot.units).toEqual([]);
    expect(snapshot.hasExistingFrontend).toBe(false);
  });

  it('validates ValidatedCommand purpose/source/status enums', () => {
    const command = ValidatedCommandSchema.parse({
      id: 'cmd-1',
      repositoryId: 'repo-1',
      purpose: 'unit-test',
      command: 'pnpm test',
      cwd: '.',
      source: 'package-script',
      status: 'validated',
    });
    expect(command.purpose).toBe('unit-test');

    expect(() =>
      ValidatedCommandSchema.parse({
        id: 'cmd-1',
        repositoryId: 'repo-1',
        purpose: 'not-a-real-purpose',
        command: 'pnpm test',
        cwd: '.',
        source: 'package-script',
        status: 'validated',
      }),
    ).toThrow();
  });

  it('parses a RepositoryFact with confidence + provenance', () => {
    const fact = RepositoryFactSchema.parse({
      id: 'fact-1',
      repositoryId: 'repo-1',
      kind: 'convention',
      statement: 'Tests live under tests/',
      confidence: 'inferred',
      observedAtSha: 'abc123',
      sourcePaths: ['tests/'],
      sourceHashes: ['deadbeef'],
      invalidatedByPaths: [],
    });
    expect(fact.confidence).toBe('inferred');
  });

  it('parses a TaskContract with acceptance claims', () => {
    const claim = AcceptanceClaimSchema.parse({
      id: 'claim-1',
      description: 'Feature works end to end',
      category: 'behavior',
      deterministicEvidenceRequired: true,
      qaEvidenceRequired: true,
      humanJudgmentRequired: false,
    });
    const contract = TaskContractSchema.parse({
      id: 'contract-1',
      taskId: 'task-1',
      version: 1,
      objective: 'Implement feature X',
      problemStatement: 'feature X is missing',
      constraints: [],
      nonGoals: [],
      risk: 'low',
      size: 'M',
      claims: [claim],
      status: 'draft',
    });
    expect(contract.claims).toHaveLength(1);
  });

  it('parses a PlanSlice with and without usesSkill', () => {
    const base = {
      id: 'slice-1',
      objective: 'do the thing',
      claimIds: [],
      likelyPaths: [],
      requiredTargetedChecks: ['test'],
      dependencies: [],
    };
    expect(PlanSliceSchema.parse(base).usesSkill).toBeUndefined();
    expect(PlanSliceSchema.parse({ ...base, usesSkill: 'build-ui' }).usesSkill).toBe('build-ui');
  });

  it('parses an ImplementationPlan', () => {
    const plan = ImplementationPlanSchema.parse({
      id: 'plan-1',
      taskId: 'task-1',
      contractVersion: 1,
      version: 1,
      summary: 'Do the thing',
      affectedAreas: ['src/'],
      slices: [],
      risks: [],
      claimCoverage: [],
      status: 'draft',
    });
    expect(plan.status).toBe('draft');
  });

  it.each([
    ['root task without stacking fields', {}],
    ['stacked task', { parentTaskId: 'task-0', baseBranch: 'awb/task-0-slug' }],
  ])('parses a Task (%s)', (_label, extra) => {
    const task = TaskSchema.parse({
      id: 'task-1',
      repositoryId: 'repo-1',
      prompt: 'do the thing',
      phase: 'specify',
      condition: 'running',
      deliveryState: 'not-started',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...extra,
    });
    expect(task.parentTaskId).toBe((extra as { parentTaskId?: string }).parentTaskId);
    expect(task.baseBranch).toBe((extra as { baseBranch?: string }).baseBranch);
  });

  it('parses a WorkspaceLease', () => {
    const lease = WorkspaceLeaseSchema.parse({
      id: 'lease-1',
      repositoryId: 'repo-1',
      taskId: 'task-1',
      baseRef: 'main',
      baseSha: 'abc123',
      branchName: 'awb/task-1-slug',
      worktreePath: '/tmp/worktree',
      executionProfile: 'native-trusted',
      allocatedPorts: { http: 4001 },
      state: 'ready',
      createdAt: new Date().toISOString(),
    });
    expect(lease.allocatedPorts.http).toBe(4001);
  });

  it('parses Evidence with optional fields omitted', () => {
    const evidence = EvidenceSchema.parse({
      id: 'ev-1',
      taskId: 'task-1',
      runId: 'run-1',
      phaseAttemptId: 'pa-1',
      kind: 'unit-test',
      status: 'passed',
      claimIds: [],
      contractVersion: 1,
      repositorySnapshotId: 'snap-1',
      policyVersion: 'v1',
      artifactIds: [],
      summary: 'All unit tests passed',
      createdAt: new Date().toISOString(),
    });
    expect(evidence.status).toBe('passed');
  });

  it('parses a Finding', () => {
    const finding = FindingSchema.parse({
      id: 'finding-1',
      taskId: 'task-1',
      severity: 'high',
      category: 'correctness',
      claimIds: [],
      description: 'Off by one error',
      status: 'open',
    });
    expect(finding.severity).toBe('high');
  });

  it('parses an ArtifactRecord', () => {
    const artifact = ArtifactRecordSchema.parse({
      id: 'artifact-1',
      sha256: 'a'.repeat(64),
      mediaType: 'video/webm',
      byteSize: 1024,
      relativePath: 'sha256/aa/aaaa',
      kind: 'qa-video',
      retention: 'task',
      createdAt: new Date().toISOString(),
    });
    expect(artifact.byteSize).toBe(1024);
  });

  it('parses a SemanticEvent', () => {
    const event = SemanticEventSchema.parse({
      id: 'event-1',
      runId: 'run-1',
      sequence: 0,
      occurredAt: new Date().toISOString(),
      phase: 'implement',
      phaseAttemptId: 'pa-1',
      producer: 'builder',
      type: 'file-changed',
      summary: 'Edited src/index.ts',
    });
    expect(event.phase).toBe('implement');
  });

  it.each([
    'phase-started',
    'phase-failed',
    'attempt-retry-scheduled',
    'transport-error',
    'session-started',
    'session-resumed',
  ] as const)('parses the control-plane SemanticEvent type %s from the workbench producer (TASK-34)', (type) => {
    const event = SemanticEventSchema.parse({
      id: 'event-cp',
      runId: 'run-1',
      sequence: 0,
      occurredAt: new Date().toISOString(),
      phase: 'implement',
      phaseAttemptId: 'pa-1',
      producer: 'workbench',
      type,
      summary: `control-plane ${type}`,
      payloadJson: { attemptNumber: 2, errorClass: 'transport-drop' },
    });
    expect(event.producer).toBe('workbench');
    expect(event.type).toBe(type);
  });

  it('discriminates PhaseAttemptResult by outcome', () => {
    const candidateResult = PhaseAttemptResultSchema.parse({
      outcome: 'candidate',
      candidate: CompletionCandidateSchema.parse({
        phase: 'verify',
        phaseAttemptId: 'pa-1',
        repositorySnapshotId: 'snap-1',
        contractVersion: 1,
        planVersion: 1,
        policyVersion: 'v1',
        evidenceIds: [],
        openFindingIds: [],
        artifactManifestHash: 'deadbeef',
      }),
    });
    expect(candidateResult.outcome).toBe('candidate');

    const repairResult = PhaseAttemptResultSchema.parse({
      outcome: 'repair',
      target: 'implement',
      findings: [],
    });
    expect(repairResult.outcome).toBe('repair');

    expect(() =>
      PhaseAttemptResultSchema.parse({ outcome: 'not-a-real-outcome' }),
    ).toThrow();
  });
});
