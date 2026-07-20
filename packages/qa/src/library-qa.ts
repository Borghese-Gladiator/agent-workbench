import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '@awb/execution';
import { ArtifactStore } from '@awb/evidence';
import type { ArtifactRecord } from '@awb/domain';
import { produceQaEvidence, type QaAssertionResult, type QaEvidenceContext } from './shared.js';

export interface LibraryQaScenario {
  /** Real JS/TS consumer script source. Must import/use the target library and print
   *  `ASSERT:<name>=true` or `ASSERT:<name>=false` lines to stdout for each check it performs. */
  consumerScriptSource: string;
  /** Extension for the temp consumer script file, e.g. "mjs" or "ts". Defaults to "mjs". */
  extension?: string;
  timeoutMs?: number;
}

export interface LibraryQaResult {
  assertions: QaAssertionResult[];
  artifacts: ArtifactRecord[];
  exitCode: number | null;
  evidence: ReturnType<typeof produceQaEvidence>;
}

const ASSERT_LINE = /^ASSERT:(.+)=(true|false)$/;

/**
 * Runs a disposable consumer script (real JS/TS via node) that imports/exercises the target
 * library, in a temp directory outside the source tree, via @awb/execution's runCommand (real
 * process, no mocking). The consumer script is expected to print `ASSERT:<name>=true|false`
 * marker lines to stdout for each check it performs; those markers are parsed back out of the
 * real captured output to build structured assertion results. A non-zero exit code with no
 * markers at all is treated as an execution error (inconclusive), not a silent pass.
 *
 * MVP scope note: only TypeScript/JS consumer execution via node is implemented. Python consumer
 * execution is out of scope for this MVP.
 */
export async function runLibraryQa(
  scenario: LibraryQaScenario,
  context: QaEvidenceContext,
  artifactStore: ArtifactStore,
): Promise<LibraryQaResult> {
  const assertions: QaAssertionResult[] = [];
  const artifacts: ArtifactRecord[] = [];
  let executionErrored = false;
  let transcriptProduced = false;

  const dir = await mkdtemp(join(tmpdir(), 'awb-qa-library-'));
  const extension = scenario.extension ?? 'mjs';
  const scriptPath = join(dir, `consumer.${extension}`);

  try {
    await writeFile(scriptPath, scenario.consumerScriptSource, 'utf8');

    const scriptArtifact = await artifactStore.put({
      source: Buffer.from(scenario.consumerScriptSource, 'utf8'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'task',
      taskId: context.taskId,
      runId: context.runId,
      phaseAttemptId: context.phaseAttemptId,
      candidateSha: context.candidateSha,
    });
    artifacts.push(scriptArtifact);

    const result = await runCommand({
      command: 'node',
      args: [scriptPath],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: scenario.timeoutMs,
    });

    const transcript = [
      `$ node ${scriptPath}`,
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

    for (const line of result.stdout.split('\n')) {
      const match = ASSERT_LINE.exec(line.trim());
      if (match) {
        assertions.push({ name: match[1] as string, passed: match[2] === 'true' });
      }
    }

    if (result.timedOut) {
      executionErrored = true;
      assertions.push({ name: 'library-execution', passed: false, detail: 'consumer script timed out' });
    } else if (assertions.length === 0 && result.exitCode !== 0) {
      executionErrored = true;
      assertions.push({
        name: 'library-execution',
        passed: false,
        detail: `consumer script exited ${result.exitCode ?? 'null'} with no ASSERT markers`,
      });
    }

    const evidence = produceQaEvidence({
      kind: 'terminal-recording',
      assertions,
      requiredArtifactProduced: transcriptProduced,
      executionErrored,
      artifactIds: artifacts.map((a) => a.id),
      summary: `Library QA: exited ${result.exitCode ?? 'null'}, ${assertions.filter((a) => a.passed).length}/${assertions.length} assertions passed`,
      context,
    });

    return { assertions, artifacts, exitCode: result.exitCode, evidence };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
