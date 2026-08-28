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

/**
 * Per-command continuation returned by {@link CommandExecutionRecorder.onCommandStart}, closed out on
 * finish to stamp `ended_at`/`exit_code` on the row opened at spawn.
 */
export interface CommandExecutionHandle {
  onCommandFinish(finish: { exitCode: number | null; endedAt: string }): Promise<void> | void;
}

/**
 * Optional hook threaded into the verification matrix so @awb/verification records live per-command
 * timing (a row on spawn, closed on finish) WITHOUT taking a hard @awb/database dependency — the
 * worker supplies a DB-backed implementation, tests supply an in-memory one. Recorder failures are
 * swallowed by the runner: observability is best-effort and never fails the command or the phase.
 */
export interface CommandExecutionRecorder {
  onCommandStart(start: {
    command: string;
    cwd: string;
    startedAt: string;
  }): Promise<CommandExecutionHandle> | CommandExecutionHandle;
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
  recorder?: CommandExecutionRecorder,
): Promise<CommandEvidenceResult> {
  // Open a command_executions row before spawning so a live/failed verify shows the command running
  // with its start time — the row is closed out below once the exit code is known. Best-effort: a
  // recorder that throws must never block the command from actually running.
  let handle: CommandExecutionHandle | undefined;
  const startedAt = new Date().toISOString();
  if (recorder) {
    try {
      handle = await recorder.onCommandStart({ command: command.command, cwd: command.cwd, startedAt });
    } catch {
      handle = undefined;
    }
  }

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

  if (handle) {
    try {
      await handle.onCommandFinish({ exitCode: result.exitCode, endedAt: new Date().toISOString() });
    } catch {
      // swallow — the row simply stays open; the command's Evidence is still authoritative.
    }
  }

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
  recorder?: CommandExecutionRecorder,
): Promise<CommandEvidenceResult[]> {
  const results: CommandEvidenceResult[] = [];
  for (const command of commands) {
    results.push(await runCommandAndRecordEvidence(command, context, artifactStore, recorder));
  }
  return results;
}

/** True only when every result in the matrix passed (product spec §11 Verify criterion: "All required deterministic commands pass"). */
export function allRequiredCommandsPass(results: CommandEvidenceResult[]): boolean {
  return results.length > 0 && results.every((r) => r.evidence.status === 'passed');
}
