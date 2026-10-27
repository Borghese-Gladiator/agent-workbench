import { runCommand } from '@awb/execution';
import { ArtifactStore } from '@awb/evidence';
import type { ArtifactRecord } from '@awb/domain';
import { produceQaEvidence, type QaAssertionResult, type QaEvidenceContext } from './shared.js';

export type CliQaExpectation =
  | { kind: 'exitCode'; equals: number }
  | { kind: 'stdoutContains'; text: string }
  | { kind: 'stderrContains'; text: string }
  | { kind: 'stdoutNotContains'; text: string };

export interface CliQaScenario {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  expectations: CliQaExpectation[];
}

export interface CliQaResult {
  assertions: QaAssertionResult[];
  artifacts: ArtifactRecord[];
  exitCode: number | null;
  evidence: ReturnType<typeof produceQaEvidence>;
}

/**
 * Runs a real CLI command via @awb/execution's runCommand (real spawn, no mocking) and evaluates
 * structured expectations against the actual captured stdout/stderr/exit code.
 *
 * MVP scope note: the "terminal-recording" artifact here is a plain text transcript
 * (stdout+stderr concatenated), not an ANSI-rendered terminal video. A captured text transcript
 * is an acceptable "terminal recording" for the MVP per the task spec; a PTY-based recording is
 * out of scope unless a specific interactive scenario later requires it.
 */
export async function runCliQa(
  scenario: CliQaScenario,
  context: QaEvidenceContext,
  artifactStore: ArtifactStore,
): Promise<CliQaResult> {
  const assertions: QaAssertionResult[] = [];
  const artifacts: ArtifactRecord[] = [];
  let executionErrored = false;
  let exitCode: number | null = null;
  let transcriptProduced = false;

  const result = await runCommand({
    command: scenario.command,
    args: scenario.args ?? [],
    cwd: scenario.cwd,
    env: scenario.env ?? ({ ...process.env } as Record<string, string>),
    timeoutMs: scenario.timeoutMs,
  });
  exitCode = result.exitCode;

  if (result.timedOut) {
    executionErrored = true;
    assertions.push({ name: 'cli-execution', passed: false, detail: 'command timed out' });
  }

  for (const expectation of scenario.expectations) {
    assertions.push(evaluateExpectation(expectation, result.stdout, result.stderr, result.exitCode));
  }

  const transcript = [
    `$ ${result.command}`,
    `cwd: ${result.cwd}`,
    `exitCode: ${result.exitCode ?? 'null'}`,
    `timedOut: ${result.timedOut}`,
    '--- stdout ---',
    result.stdout,
    '--- stderr ---',
    result.stderr,
  ].join('\n');

  try {
    const transcriptArtifact = await artifactStore.put({
      source: Buffer.from(transcript, 'utf8'),
      mediaType: 'text/plain',
      kind: 'terminal-recording',
      retention: 'task',
      taskId: context.taskId,
      runId: context.runId,
      phaseAttemptId: context.phaseAttemptId,
      candidateSha: context.candidateSha,
    });
    artifacts.push(transcriptArtifact);
    transcriptProduced = true;
  } catch {
    transcriptProduced = false;
  }

  const evidence = produceQaEvidence({
    kind: 'terminal-recording',
    assertions,
    requiredArtifactProduced: transcriptProduced,
    executionErrored,
    artifactIds: artifacts.map((a) => a.id),
    summary: `CLI QA: ${result.command} exited ${result.exitCode ?? 'null'}, ${assertions.filter((a) => a.passed).length}/${assertions.length} assertions passed`,
    context,
  });

  return { assertions, artifacts, exitCode, evidence };
}

function evaluateExpectation(
  expectation: CliQaExpectation,
  stdout: string,
  stderr: string,
  exitCode: number | null,
): QaAssertionResult {
  switch (expectation.kind) {
    case 'exitCode':
      return {
        name: `exitCode=${expectation.equals}`,
        passed: exitCode === expectation.equals,
        detail: `actual exitCode=${exitCode ?? 'null'}`,
      };
    case 'stdoutContains':
      return {
        name: `stdoutContains:${expectation.text}`,
        passed: stdout.includes(expectation.text),
      };
    case 'stdoutNotContains':
      return {
        name: `stdoutNotContains:${expectation.text}`,
        passed: !stdout.includes(expectation.text),
      };
    case 'stderrContains':
      return {
        name: `stderrContains:${expectation.text}`,
        passed: stderr.includes(expectation.text),
      };
  }
}
