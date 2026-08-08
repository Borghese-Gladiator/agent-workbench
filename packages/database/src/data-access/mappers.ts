import type {
  TaskContract,
  AcceptanceClaim,
  ImplementationPlan,
  PlanSlice,
  ClaimCoverage,
  ProgramDesign,
  Evidence,
  Finding,
  WorkspaceLease,
  ArtifactRecord,
  ExpectedAssertion,
} from '@awb/domain';
import type {
  TaskContractRow,
  AcceptanceClaimRow,
  PlanRow,
  PlanSliceRow,
  PlanClaimCoverageRow,
  ProgramDesignRow,
  EvidenceRow,
  FindingRow,
  WorkspaceLeaseRow,
  ArtifactRow,
} from '../row-types.js';

/**
 * Row ⇄ domain mappers for the run-lifecycle entities the worker persists through the daemon.
 * The schema stores arrays/records as JSON text columns (`*_json`); these functions are
 * the single place that (de)serializes them, so the data-access helpers and the daemon's rehydration
 * route never hand-roll `JSON.parse`. Every mapper round-trips: `rowToX(xToRow(x)) deepEquals x`.
 */

function parseArray(json: string): string[] {
  const value = JSON.parse(json);
  return Array.isArray(value) ? value : [];
}

function parseExpectedAssertions(json: string): ExpectedAssertion[] {
  const value = JSON.parse(json);
  return Array.isArray(value) ? (value as ExpectedAssertion[]) : [];
}

// --- TaskContract (+ acceptance claims) ---

export function contractToRow(contract: TaskContract): TaskContractRow {
  return {
    id: contract.id,
    taskId: contract.taskId,
    version: contract.version,
    objective: contract.objective,
    problemStatement: contract.problemStatement,
    constraintsJson: JSON.stringify(contract.constraints),
    nonGoalsJson: JSON.stringify(contract.nonGoals),
    risk: contract.risk,
    size: contract.size,
    status: contract.status,
  };
}

export function claimToRow(claim: AcceptanceClaim, taskContractId: string): AcceptanceClaimRow {
  return {
    id: claim.id,
    taskContractId,
    description: claim.description,
    category: claim.category,
    deterministicEvidenceRequired: claim.deterministicEvidenceRequired,
    qaEvidenceRequired: claim.qaEvidenceRequired,
    humanJudgmentRequired: claim.humanJudgmentRequired,
  };
}

export function rowToClaim(row: AcceptanceClaimRow): AcceptanceClaim {
  return {
    id: row.id,
    description: row.description,
    category: row.category,
    deterministicEvidenceRequired: row.deterministicEvidenceRequired,
    qaEvidenceRequired: row.qaEvidenceRequired,
    humanJudgmentRequired: row.humanJudgmentRequired,
  };
}

export function rowToContract(row: TaskContractRow, claims: AcceptanceClaimRow[]): TaskContract {
  return {
    id: row.id,
    taskId: row.taskId,
    version: row.version,
    objective: row.objective,
    problemStatement: row.problemStatement,
    constraints: parseArray(row.constraintsJson),
    nonGoals: parseArray(row.nonGoalsJson),
    risk: row.risk,
    size: row.size ?? 'M',
    claims: claims.map(rowToClaim),
    status: row.status,
  };
}

// --- ImplementationPlan (+ slices, claim coverage) ---

export function planToRow(plan: ImplementationPlan): PlanRow {
  return {
    id: plan.id,
    taskId: plan.taskId,
    contractVersion: plan.contractVersion,
    version: plan.version,
    summary: plan.summary,
    affectedAreasJson: JSON.stringify(plan.affectedAreas),
    risksJson: JSON.stringify(plan.risks),
    status: plan.status,
  };
}

export function sliceToRow(slice: PlanSlice, planId: string): PlanSliceRow {
  return {
    id: slice.id,
    planId,
    objective: slice.objective,
    claimIdsJson: JSON.stringify(slice.claimIds),
    likelyPathsJson: JSON.stringify(slice.likelyPaths),
    requiredTargetedChecksJson: JSON.stringify(slice.requiredTargetedChecks),
    dependenciesJson: JSON.stringify(slice.dependencies),
  };
}

export function rowToSlice(row: PlanSliceRow, qaScenarioIds?: string[]): PlanSlice {
  return {
    id: row.id,
    objective: row.objective,
    claimIds: parseArray(row.claimIdsJson),
    likelyPaths: parseArray(row.likelyPathsJson),
    requiredTargetedChecks: parseArray(row.requiredTargetedChecksJson),
    dependencies: parseArray(row.dependenciesJson),
    ...(qaScenarioIds && qaScenarioIds.length > 0 ? { qaScenarioIds } : {}),
  };
}

export function coverageToRow(coverage: ClaimCoverage, planId: string): Omit<PlanClaimCoverageRow, 'id'> {
  return {
    planId,
    claimId: coverage.claimId,
    planSliceIdsJson: JSON.stringify(coverage.planSliceIds),
    qaScenarioIdsJson: JSON.stringify(coverage.qaScenarioIds),
    expectedAssertionsJson: JSON.stringify(coverage.expectedAssertions ?? []),
  };
}

export function rowToCoverage(row: PlanClaimCoverageRow): ClaimCoverage {
  const expectedAssertions = parseExpectedAssertions(row.expectedAssertionsJson);
  return {
    claimId: row.claimId,
    planSliceIds: parseArray(row.planSliceIdsJson),
    qaScenarioIds: parseArray(row.qaScenarioIdsJson),
    ...(expectedAssertions.length > 0 ? { expectedAssertions } : {}),
  };
}

export function rowToPlan(
  row: PlanRow,
  slices: PlanSliceRow[],
  coverage: PlanClaimCoverageRow[],
): ImplementationPlan {
  const coverageByClaim = coverage.map(rowToCoverage);
  // A slice's qaScenarioIds are not stored on the slice row; the plan gate reads them from the
  // per-claim coverage. Reattach them so `rowToSlice` reproduces the original PlanSlice shape.
  const scenarioIdsForSlice = (sliceId: string): string[] => {
    const ids = new Set<string>();
    for (const c of coverageByClaim) {
      if (c.planSliceIds.includes(sliceId)) c.qaScenarioIds.forEach((id) => ids.add(id));
    }
    return [...ids];
  };
  return {
    id: row.id,
    taskId: row.taskId,
    contractVersion: row.contractVersion,
    version: row.version,
    summary: row.summary,
    affectedAreas: parseArray(row.affectedAreasJson),
    slices: slices.map((s) => rowToSlice(s, scenarioIdsForSlice(s.id))),
    risks: JSON.parse(row.risksJson),
    claimCoverage: coverageByClaim,
    status: row.status,
  };
}

// --- ProgramDesign ---

export function programDesignToRow(design: ProgramDesign): ProgramDesignRow {
  return {
    id: design.id,
    taskId: design.taskId,
    planVersion: design.planVersion,
    version: design.version,
    fileTreeDiffJson: JSON.stringify(design.fileTreeDiff),
    typeSignaturesJson: JSON.stringify(design.typeSignatures),
    functionSignaturesJson: JSON.stringify(design.functionSignatures),
  };
}

export function rowToProgramDesign(row: ProgramDesignRow): ProgramDesign {
  return {
    id: row.id,
    taskId: row.taskId,
    planVersion: row.planVersion,
    version: row.version,
    fileTreeDiff: parseArray(row.fileTreeDiffJson),
    typeSignatures: JSON.parse(row.typeSignaturesJson),
    functionSignatures: JSON.parse(row.functionSignaturesJson),
  };
}

// --- Evidence ---

export function evidenceToRow(evidence: Evidence): EvidenceRow {
  return {
    id: evidence.id,
    taskId: evidence.taskId,
    runId: evidence.runId,
    phaseAttemptId: evidence.phaseAttemptId,
    kind: evidence.kind,
    status: evidence.status,
    claimIdsJson: JSON.stringify(evidence.claimIds),
    contractVersion: evidence.contractVersion,
    planVersion: evidence.planVersion ?? null,
    repositorySnapshotId: evidence.repositorySnapshotId,
    baseSha: evidence.baseSha ?? null,
    candidateSha: evidence.candidateSha ?? null,
    environmentDigest: evidence.environmentDigest ?? null,
    scenarioVersion: evidence.scenarioVersion ?? null,
    policyVersion: evidence.policyVersion,
    artifactIdsJson: JSON.stringify(evidence.artifactIds),
    summary: evidence.summary,
    createdAt: evidence.createdAt,
  };
}

export function rowToEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    phaseAttemptId: row.phaseAttemptId,
    kind: row.kind,
    status: row.status,
    claimIds: parseArray(row.claimIdsJson),
    contractVersion: row.contractVersion,
    ...(row.planVersion != null ? { planVersion: row.planVersion } : {}),
    repositorySnapshotId: row.repositorySnapshotId,
    ...(row.baseSha != null ? { baseSha: row.baseSha } : {}),
    ...(row.candidateSha != null ? { candidateSha: row.candidateSha } : {}),
    ...(row.environmentDigest != null ? { environmentDigest: row.environmentDigest } : {}),
    ...(row.scenarioVersion != null ? { scenarioVersion: row.scenarioVersion } : {}),
    policyVersion: row.policyVersion,
    artifactIds: parseArray(row.artifactIdsJson),
    summary: row.summary,
    createdAt: row.createdAt,
  };
}

// --- Finding ---

export function findingToRow(finding: Finding): FindingRow {
  return {
    id: finding.id,
    taskId: finding.taskId,
    candidateSha: finding.candidateSha ?? null,
    severity: finding.severity,
    category: finding.category,
    claimIdsJson: JSON.stringify(finding.claimIds),
    path: finding.path ?? null,
    line: finding.line ?? null,
    description: finding.description,
    reproductionJson: finding.reproduction ? JSON.stringify(finding.reproduction) : null,
    proposedRemediation: finding.proposedRemediation ?? null,
    status: finding.status,
  };
}

export function rowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    taskId: row.taskId,
    ...(row.candidateSha != null ? { candidateSha: row.candidateSha } : {}),
    severity: row.severity,
    category: row.category,
    claimIds: parseArray(row.claimIdsJson),
    ...(row.path != null ? { path: row.path } : {}),
    ...(row.line != null ? { line: row.line } : {}),
    description: row.description,
    ...(row.reproductionJson != null ? { reproduction: parseArray(row.reproductionJson) } : {}),
    ...(row.proposedRemediation != null ? { proposedRemediation: row.proposedRemediation } : {}),
    status: row.status,
  };
}

// --- WorkspaceLease ---

export function leaseToRow(lease: WorkspaceLease): WorkspaceLeaseRow {
  return {
    id: lease.id,
    repositoryId: lease.repositoryId,
    taskId: lease.taskId,
    baseRef: lease.baseRef,
    baseSha: lease.baseSha,
    branchName: lease.branchName,
    worktreePath: lease.worktreePath,
    executionProfile: lease.executionProfile,
    allocatedPortsJson: JSON.stringify(lease.allocatedPorts),
    state: lease.state,
    createdAt: lease.createdAt,
  };
}

export function rowToLease(row: WorkspaceLeaseRow): WorkspaceLease {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    taskId: row.taskId,
    baseRef: row.baseRef,
    baseSha: row.baseSha,
    branchName: row.branchName,
    worktreePath: row.worktreePath,
    executionProfile: row.executionProfile,
    allocatedPorts: JSON.parse(row.allocatedPortsJson),
    state: row.state,
    createdAt: row.createdAt,
  };
}

// --- ArtifactRecord ---

export function artifactToRow(record: ArtifactRecord): ArtifactRow {
  return {
    id: record.id,
    sha256: record.sha256,
    mediaType: record.mediaType,
    byteSize: record.byteSize,
    relativePath: record.relativePath,
    taskId: record.taskId ?? null,
    runId: record.runId ?? null,
    phaseAttemptId: record.phaseAttemptId ?? null,
    candidateSha: record.candidateSha ?? null,
    kind: record.kind,
    retention: record.retention,
    createdAt: record.createdAt,
  };
}

export function rowToArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    sha256: row.sha256,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    relativePath: row.relativePath,
    ...(row.taskId != null ? { taskId: row.taskId } : {}),
    ...(row.runId != null ? { runId: row.runId } : {}),
    ...(row.phaseAttemptId != null ? { phaseAttemptId: row.phaseAttemptId } : {}),
    ...(row.candidateSha != null ? { candidateSha: row.candidateSha } : {}),
    kind: row.kind,
    retention: row.retention,
    createdAt: row.createdAt,
  };
}
