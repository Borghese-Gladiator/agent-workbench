import { eq } from 'drizzle-orm';
import type {
  TaskContract,
  ImplementationPlan,
  ProgramDesign,
  Evidence,
  Finding,
  WorkspaceLease,
  ArtifactRecord,
  RunStateSnapshot,
} from '@awb/domain';
import { ensureRun, ensurePhaseAttempt } from './tasks.js';
import { getBuilderResumeSessions } from './observability.js';
import {
  taskContracts,
  acceptanceClaims,
  plans,
  planSlices,
  planClaimCoverage,
  programDesigns,
  evidence as evidenceTable,
  evidenceClaims,
  findings,
  workspaceLeases,
  artifacts,
} from '../schema/index.js';
import type { DrizzleDb } from '../connection.js';
import {
  contractToRow,
  claimToRow,
  rowToContract,
  planToRow,
  sliceToRow,
  coverageToRow,
  rowToPlan,
  programDesignToRow,
  rowToProgramDesign,
  evidenceToRow,
  rowToEvidence,
  findingToRow,
  rowToFinding,
  leaseToRow,
  rowToLease,
  artifactToRow,
  rowToArtifact,
} from './mappers.js';

/**
 * Write/read helpers for the run-lifecycle entities the worker persists through the daemon.
 * Every write is idempotent (re-running a phase attempt re-persists the same row without error), so a
 * Temporal activity retry never produces duplicates. All functions take a Drizzle handle and are used
 * only by the daemon — the single application writer (docs/storage.md).
 */

// --- TaskContract ---

export function upsertContract(db: DrizzleDb, contract: TaskContract): void {
  const row = contractToRow(contract);
  db.transaction((tx) => {
    tx.insert(taskContracts)
      .values(row)
      .onConflictDoUpdate({ target: taskContracts.id, set: row })
      .run();
    // Replace the contract's claims wholesale — the set is small and versioned with the contract.
    tx.delete(acceptanceClaims).where(eq(acceptanceClaims.taskContractId, contract.id)).run();
    for (const claim of contract.claims) {
      tx.insert(acceptanceClaims).values(claimToRow(claim, contract.id)).run();
    }
  });
}

export function getContract(db: DrizzleDb, contractId: string): TaskContract | undefined {
  const rows = db.select().from(taskContracts).where(eq(taskContracts.id, contractId)).all();
  const row = rows[0];
  if (!row) return undefined;
  const claims = db
    .select()
    .from(acceptanceClaims)
    .where(eq(acceptanceClaims.taskContractId, contractId))
    .all();
  return rowToContract(row, claims);
}

// --- ImplementationPlan ---

export function upsertPlan(db: DrizzleDb, plan: ImplementationPlan): void {
  const row = planToRow(plan);
  db.transaction((tx) => {
    tx.insert(plans).values(row).onConflictDoUpdate({ target: plans.id, set: row }).run();
    tx.delete(planSlices).where(eq(planSlices.planId, plan.id)).run();
    for (const slice of plan.slices) {
      tx.insert(planSlices).values(sliceToRow(slice, plan.id)).run();
    }
    tx.delete(planClaimCoverage).where(eq(planClaimCoverage.planId, plan.id)).run();
    for (const coverage of plan.claimCoverage) {
      tx.insert(planClaimCoverage).values(coverageToRow(coverage, plan.id)).run();
    }
  });
}

export function getPlan(db: DrizzleDb, planId: string): ImplementationPlan | undefined {
  const rows = db.select().from(plans).where(eq(plans.id, planId)).all();
  const row = rows[0];
  if (!row) return undefined;
  const slices = db.select().from(planSlices).where(eq(planSlices.planId, planId)).all();
  const coverage = db.select().from(planClaimCoverage).where(eq(planClaimCoverage.planId, planId)).all();
  return rowToPlan(row, slices, coverage);
}

// --- ProgramDesign ---

export function upsertProgramDesign(db: DrizzleDb, design: ProgramDesign): void {
  const row = programDesignToRow(design);
  db.insert(programDesigns).values(row).onConflictDoUpdate({ target: programDesigns.id, set: row }).run();
}

export function getProgramDesignByTask(db: DrizzleDb, taskId: string): ProgramDesign | undefined {
  const rows = db.select().from(programDesigns).where(eq(programDesigns.taskId, taskId)).all();
  const row = rows[rows.length - 1];
  return row ? rowToProgramDesign(row) : undefined;
}

// --- Evidence ---

export function insertEvidence(db: DrizzleDb, evidence: Evidence): void {
  const row = evidenceToRow(evidence);
  db.transaction((tx) => {
    tx.insert(evidenceTable).values(row).onConflictDoUpdate({ target: evidenceTable.id, set: row }).run();
    tx.delete(evidenceClaims).where(eq(evidenceClaims.evidenceId, evidence.id)).run();
    for (const claimId of evidence.claimIds) {
      tx.insert(evidenceClaims).values({ evidenceId: evidence.id, claimId }).run();
    }
  });
}

export function getEvidence(db: DrizzleDb, evidenceId: string): Evidence | undefined {
  const rows = db.select().from(evidenceTable).where(eq(evidenceTable.id, evidenceId)).all();
  const row = rows[0];
  return row ? rowToEvidence(row) : undefined;
}

export function listEvidenceByTask(db: DrizzleDb, taskId: string): Evidence[] {
  return db.select().from(evidenceTable).where(eq(evidenceTable.taskId, taskId)).all().map(rowToEvidence);
}

// --- Finding ---

export function insertFinding(db: DrizzleDb, finding: Finding): void {
  const row = findingToRow(finding);
  db.insert(findings).values(row).onConflictDoUpdate({ target: findings.id, set: row }).run();
}

export function getFinding(db: DrizzleDb, findingId: string): Finding | undefined {
  const rows = db.select().from(findings).where(eq(findings.id, findingId)).all();
  const row = rows[0];
  return row ? rowToFinding(row) : undefined;
}

export function listFindingsByTask(db: DrizzleDb, taskId: string): Finding[] {
  return db.select().from(findings).where(eq(findings.taskId, taskId)).all().map(rowToFinding);
}

// --- WorkspaceLease ---

export function upsertWorkspaceLease(db: DrizzleDb, lease: WorkspaceLease): void {
  const row = leaseToRow(lease);
  db.insert(workspaceLeases).values(row).onConflictDoUpdate({ target: workspaceLeases.id, set: row }).run();
}

export function getWorkspaceLease(db: DrizzleDb, leaseId: string): WorkspaceLease | undefined {
  const rows = db.select().from(workspaceLeases).where(eq(workspaceLeases.id, leaseId)).all();
  const row = rows[0];
  return row ? rowToLease(row) : undefined;
}

// --- ArtifactRecord (metadata; the blob lives in the content-addressed store) ---

export function insertArtifact(db: DrizzleDb, record: ArtifactRecord): void {
  const row = artifactToRow(record);
  db.insert(artifacts).values(row).onConflictDoUpdate({ target: artifacts.id, set: row }).run();
}

export function getArtifact(db: DrizzleDb, artifactId: string): ArtifactRecord | undefined {
  const rows = db.select().from(artifacts).where(eq(artifacts.id, artifactId)).all();
  const row = rows[0];
  return row ? rowToArtifact(row) : undefined;
}

export function getArtifactBySha256(db: DrizzleDb, sha256: string): ArtifactRecord | undefined {
  const rows = db.select().from(artifacts).where(eq(artifacts.sha256, sha256)).all();
  const row = rows[0];
  return row ? rowToArtifact(row) : undefined;
}

export function listArtifactsByTask(db: DrizzleDb, taskId: string): ArtifactRecord[] {
  return db.select().from(artifacts).where(eq(artifacts.taskId, taskId)).all().map(rowToArtifact);
}

export function listArtifactsByCandidateSha(db: DrizzleDb, candidateSha: string): ArtifactRecord[] {
  return db.select().from(artifacts).where(eq(artifacts.candidateSha, candidateSha)).all().map(rowToArtifact);
}

export function deleteArtifact(db: DrizzleDb, artifactId: string): void {
  db.delete(artifacts).where(eq(artifacts.id, artifactId)).run();
}

export function listAllArtifacts(db: DrizzleDb): ArtifactRecord[] {
  return db.select().from(artifacts).all().map(rowToArtifact);
}

// --- RunStateSnapshot (the worker→daemon durability payload) ---

/**
 * Persists a whole run-state snapshot in one transaction: the contract, plan, workspace lease,
 * accumulated evidence, review findings, and artifact metadata. Idempotent, so a re-invoked phase
 * attempt (Temporal retry) re-persists the same rows without duplication. Evidence rows reference
 * `runs`/`phase_attempts` by FK, so those parent rows are ensured first from each evidence row's
 * own ids.
 */
export function persistRunStateSnapshot(db: DrizzleDb, snapshot: RunStateSnapshot): void {
  db.transaction((tx) => {
    if (snapshot.contract) upsertContract(tx as unknown as DrizzleDb, snapshot.contract);
    if (snapshot.plan) upsertPlan(tx as unknown as DrizzleDb, snapshot.plan);
    if (snapshot.programDesign) upsertProgramDesign(tx as unknown as DrizzleDb, snapshot.programDesign);
    if (snapshot.lease) upsertWorkspaceLease(tx as unknown as DrizzleDb, snapshot.lease);

    for (const record of snapshot.artifacts) {
      // Artifacts FK to runs/phase_attempts (schema evidence.ts). Unlike evidence, an artifact can
      // be persisted before any evidence exists for its attempt (e.g. the plan phase writes a plan
      // artifact with no verification/QA evidence yet), so ensure its parents from its own ids here
      // rather than relying on the evidence loop below.
      if (record.taskId) {
        ensureRun(tx as unknown as DrizzleDb, record.taskId);
        if (record.phaseAttemptId) {
          ensurePhaseAttemptFromId(tx as unknown as DrizzleDb, record.taskId, record.phaseAttemptId);
        }
      }
      insertArtifact(tx as unknown as DrizzleDb, record);
    }

    const allEvidence = [...snapshot.verificationEvidence, ...snapshot.qaEvidence];
    for (const evidence of allEvidence) {
      ensureRun(tx as unknown as DrizzleDb, evidence.taskId);
      // The phaseAttemptId is `${taskId}-${phase}-${attempt}`; ensurePhaseAttempt keys off the same
      // id shape, so parse the phase/attempt back out to satisfy the FK deterministically.
      ensurePhaseAttemptFromId(tx as unknown as DrizzleDb, evidence.taskId, evidence.phaseAttemptId);
      insertEvidence(tx as unknown as DrizzleDb, evidence);
    }

    for (const finding of snapshot.reviewFindings) {
      insertFinding(tx as unknown as DrizzleDb, finding);
    }
  });
}

/**
 * Ensures the `phase_attempts` parent row for an evidence row whose `phaseAttemptId` follows the
 * driver's `${taskId}-${phase}-${attempt}` convention (buildPhaseAttempt). Falls back to a single
 * synthetic attempt row when the id doesn't parse, so a snapshot never fails the FK.
 */
function ensurePhaseAttemptFromId(db: DrizzleDb, taskId: string, phaseAttemptId: string): void {
  const suffix = phaseAttemptId.startsWith(`${taskId}-`)
    ? phaseAttemptId.slice(taskId.length + 1)
    : phaseAttemptId;
  const lastDash = suffix.lastIndexOf('-');
  const phase = lastDash > 0 ? suffix.slice(0, lastDash) : suffix;
  const attemptNumber = lastDash > 0 ? Number.parseInt(suffix.slice(lastDash + 1), 10) : 1;
  ensurePhaseAttempt(db, {
    taskId,
    phase: phase as Parameters<typeof ensurePhaseAttempt>[1]['phase'],
    attemptNumber: Number.isFinite(attemptNumber) ? attemptNumber : 1,
  });
}

/**
 * Rehydrates a run-state snapshot from SQLite for a task (worker restart recovery). Reads only the
 * durable rows; the `ArtifactStore` instance is reconstructed by the worker around the artifact
 * metadata, not here. Returns undefined if the task has no persisted rows at all.
 */
export function loadRunStateSnapshot(
  db: DrizzleDb,
  task: { taskId: string; repositoryId: string; prompt?: string },
): RunStateSnapshot {
  const contractRow = db.select().from(taskContracts).where(eq(taskContracts.taskId, task.taskId)).all();
  const contract = contractRow[0] ? getContract(db, contractRow[0].id) : undefined;

  const planRow = db.select().from(plans).where(eq(plans.taskId, task.taskId)).all();
  const plan = planRow[0] ? getPlan(db, planRow[0].id) : undefined;

  const programDesign = getProgramDesignByTask(db, task.taskId);

  const leaseRow = db.select().from(workspaceLeases).where(eq(workspaceLeases.taskId, task.taskId)).all();
  const lease = leaseRow[0] ? rowToLease(leaseRow[0]) : undefined;

  const QA_EVIDENCE_KINDS = new Set(['qa-video', 'browser-trace', 'terminal-recording', 'screenshot']);
  const allEvidence = listEvidenceByTask(db, task.taskId);
  const verificationEvidence = allEvidence.filter((e) => !QA_EVIDENCE_KINDS.has(e.kind));
  const qaEvidence = allEvidence.filter((e) => QA_EVIDENCE_KINDS.has(e.kind));

  // candidateSha is not a first-class run-state row; recover it from any evidence keyed to it (all
  // evidence for a task shares the same candidate SHA once the builder has committed).
  const candidateSha = allEvidence.find((e) => e.candidateSha)?.candidateSha;

  // Builder resume tokens, reconstructed from the persisted agent_sessions rows so a worker
  // restart resumes each slice's transcript instead of cold-starting.
  const builderResumeSessions = getBuilderResumeSessions(db, task.taskId);

  return {
    taskId: task.taskId,
    repositoryId: task.repositoryId,
    ...(task.prompt !== undefined ? { prompt: task.prompt } : {}),
    ...(contract ? { contract, size: contract.size } : {}),
    ...(plan ? { plan } : {}),
    ...(programDesign ? { programDesign } : {}),
    ...(lease ? { lease, worktreePath: lease.worktreePath, baseSha: lease.baseSha } : {}),
    ...(candidateSha ? { candidateSha } : {}),
    ...(builderResumeSessions ? { builderResumeSessions } : {}),
    verificationEvidence,
    qaEvidence,
    reviewFindings: listFindingsByTask(db, task.taskId),
    artifacts: listArtifactsByTask(db, task.taskId),
  };
}
