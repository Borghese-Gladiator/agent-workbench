import { randomUUID } from 'node:crypto';
import { runCommand, type CommandResult } from '@awb/execution';
import { ArtifactStore } from '@awb/evidence';
import type { Evidence, EvidenceStatus, ValidatedCommand } from '@awb/domain';

/**
 * Splits a shell-style command string into an executable + args, honoring single/double-quoted
 * segments (so `node -e "process.exit(1)"` keeps its quoted argument intact rather than
 * shattering on the spaces inside the quotes). Not a full shell parser — no variable expansion,
 * globbing, or pipes — those never apply to a ValidatedCommand, which is a single literal
 * executable invocation by construction.
 */
export function splitCommandString(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

export interface VerificationRunContext {
  taskId: string;
  runId: string;
  phaseAttemptId: string;
  repositorySnapshotId: string;
  contractVersion: number;
  planVersion?: number;
  candidateSha?: string;
  baseSha?: string;
  environmentDigest?: string;
  policyVersion: string;
  claimIds: string[];
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface CommandEvidenceResult {
  command: ValidatedCommand;
  result: CommandResult;
  evidence: Evidence;
}

function evidenceKindForPurpose(purpose: ValidatedCommand['purpose']): Evidence['kind'] {
  switch (purpose) {
    case 'unit-test':
      return 'unit-test';
    case 'integration-test':
      return 'integration-test';
    case 'build':
      return 'build';
    case 'lint':
    case 'format':
    case 'typecheck':
      return 'static-check';
    default:
      return 'static-check';
  }
}

function statusFor(result: CommandResult): EvidenceStatus {
  if (result.timedOut) return 'inconclusive';
  if (result.exitCode === 0) return 'passed';
  if (result.exitCode === null) return 'inconclusive';
  return 'failed';
}

/**
 * Runs one validated repository command and produces structured Evidence (product spec §22).
 * Only ValidatedCommand rows with status "validated" should be passed in by the caller — the
 * builder cannot redefine what gets run here (spec §22: "The builder cannot redefine them").
 */
export async function runCommandAndRecordEvidence(
  command: ValidatedCommand,
  context: VerificationRunContext,
  artifactStore: ArtifactStore,
): Promise<CommandEvidenceResult> {
  // ValidatedCommand.command is a full shell-style string (e.g. "pnpm test"); @awb/execution's
  // runCommand spawns without a shell, so it needs the executable and args split apart.
  const [executable, ...args] = splitCommandString(command.command);
  const result = await runCommand({
    command: executable ?? command.command,
    args,
    cwd: command.cwd,
    env: context.env,
    timeoutMs: context.timeoutMs,
  });

  const stdoutArtifact = await artifactStore.put({
    source: Buffer.from(result.stdout, 'utf8'),
    mediaType: 'text/plain',
    kind: 'command-log',
    retention: 'task',
    taskId: context.taskId,
    runId: context.runId,
    phaseAttemptId: context.phaseAttemptId,
    candidateSha: context.candidateSha,
  });
  const stderrArtifact = await artifactStore.put({
    source: Buffer.from(result.stderr, 'utf8'),
    mediaType: 'text/plain',
    kind: 'command-log',
    retention: 'task',
    taskId: context.taskId,
    runId: context.runId,
    phaseAttemptId: context.phaseAttemptId,
    candidateSha: context.candidateSha,
  });

  const status = statusFor(result);
  const evidence: Evidence = {
    id: randomUUID(),
    taskId: context.taskId,
    runId: context.runId,
    phaseAttemptId: context.phaseAttemptId,
    kind: evidenceKindForPurpose(command.purpose),
    status,
    claimIds: context.claimIds,
    contractVersion: context.contractVersion,
    planVersion: context.planVersion,
    repositorySnapshotId: context.repositorySnapshotId,
    baseSha: context.baseSha,
    candidateSha: context.candidateSha,
    environmentDigest: context.environmentDigest,
    policyVersion: context.policyVersion,
    artifactIds: [stdoutArtifact.id, stderrArtifact.id],
    summary: `${command.command} exited ${result.exitCode ?? 'null'} (${status})`,
    createdAt: new Date().toISOString(),
  };

  return { command, result, evidence };
}

/** Runs every given validated command in order, recording Evidence for each (product spec §22). */
export async function runVerificationMatrix(
  commands: ValidatedCommand[],
  context: VerificationRunContext,
  artifactStore: ArtifactStore,
): Promise<CommandEvidenceResult[]> {
  const results: CommandEvidenceResult[] = [];
  for (const command of commands) {
    results.push(await runCommandAndRecordEvidence(command, context, artifactStore));
  }
  return results;
}

/** True only when every result in the matrix passed (product spec §11 Verify criterion: "All required deterministic commands pass"). */
export function allRequiredCommandsPass(results: CommandEvidenceResult[]): boolean {
  return results.length > 0 && results.every((r) => r.evidence.status === 'passed');
}
