import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import { runCommandAndRecordEvidence, runVerificationMatrix, allRequiredCommandsPass } from './verification-runner.js';
import type { ValidatedCommand } from '@awb/domain';

const baseContext = {
  taskId: 'task-1',
  runId: 'run-1',
  phaseAttemptId: 'pa-1',
  repositorySnapshotId: 'snap-1',
  contractVersion: 1,
  planVersion: 1,
  candidateSha: 'a'.repeat(40),
  environmentDigest: 'digest-1',
  policyVersion: 'v1',
  claimIds: ['claim-1'],
  // Real caller (Milestone 10's daemon) is responsible for the actual per-repository env
  // allowlist per spec §33 — tests here only need PATH so `node`/`echo` resolve via spawn's
  // no-shell lookup, not a permissive default.
  env: { PATH: process.env.PATH ?? '' },
};

function makeCommand(overrides: Partial<ValidatedCommand> = {}): ValidatedCommand {
  return {
    id: 'cmd-1',
    repositoryId: 'repo-1',
    purpose: 'unit-test',
    command: 'echo hello',
    cwd: process.cwd(),
    source: 'package-script',
    status: 'validated',
    ...overrides,
  };
}

describe('runCommandAndRecordEvidence', () => {
  let artifactsDir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), 'awb-verify-artifacts-'));
    store = new ArtifactStore(artifactsDir, new InMemoryArtifactMetadataStore());
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('records passed evidence for a real successful command', async () => {
    const command = makeCommand({ command: 'echo hello-world' });
    const { evidence, result } = await runCommandAndRecordEvidence(command, baseContext, store);
    expect(result.exitCode).toBe(0);
    expect(evidence.status).toBe('passed');
    expect(evidence.kind).toBe('unit-test');
    expect(evidence.candidateSha).toBe(baseContext.candidateSha);
    expect(evidence.artifactIds).toHaveLength(2);
  });

  it('captures real stdout as a retrievable artifact', async () => {
    const command = makeCommand({ command: 'echo captured-output-marker' });
    const { evidence } = await runCommandAndRecordEvidence(command, baseContext, store);
    const stdoutArtifactId = evidence.artifactIds[0] as string;
    const artifact = store.get(stdoutArtifactId);
    expect(artifact).toBeDefined();
    const { readFile } = await import('node:fs/promises');
    const contents = await readFile(artifact!.path, 'utf8');
    expect(contents).toContain('captured-output-marker');
  });

  it('records failed evidence for a real non-zero exit', async () => {
    const failing = makeCommand({ command: 'node -e "process.exit(1)"' });
    const { evidence, result } = await runCommandAndRecordEvidence(failing, baseContext, store);
    expect(result.exitCode).toBe(1);
    expect(evidence.status).toBe('failed');
  });

  it('records inconclusive evidence when the command times out', async () => {
    const command = makeCommand({ command: 'node -e "setTimeout(() => {}, 5000)"' });
    const { evidence, result } = await runCommandAndRecordEvidence(
      command,
      { ...baseContext, timeoutMs: 150 },
      store,
    );
    expect(result.timedOut).toBe(true);
    expect(evidence.status).toBe('inconclusive');
  });

  it('classifies static-check purposes (lint/format/typecheck) as evidence kind static-check', async () => {
    const lintCommand = makeCommand({ purpose: 'lint', command: 'echo lint-ok' });
    const { evidence } = await runCommandAndRecordEvidence(lintCommand, baseContext, store);
    expect(evidence.kind).toBe('static-check');
  });

  it('classifies build purpose as evidence kind build', async () => {
    const buildCommand = makeCommand({ purpose: 'build', command: 'echo build-ok' });
    const { evidence } = await runCommandAndRecordEvidence(buildCommand, baseContext, store);
    expect(evidence.kind).toBe('build');
  });
});

describe('runVerificationMatrix / allRequiredCommandsPass', () => {
  let artifactsDir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), 'awb-verify-matrix-'));
    store = new ArtifactStore(artifactsDir, new InMemoryArtifactMetadataStore());
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('reports all-pass true when every command in the matrix succeeds', async () => {
    const commands = [
      makeCommand({ id: 'c1', command: 'echo one' }),
      makeCommand({ id: 'c2', command: 'echo two', purpose: 'lint' }),
    ];
    const results = await runVerificationMatrix(commands, baseContext, store);
    expect(allRequiredCommandsPass(results)).toBe(true);
  });

  it('reports all-pass false when any command in the matrix fails', async () => {
    const commands = [
      makeCommand({ id: 'c1', command: 'echo one' }),
      makeCommand({ id: 'c2', command: 'node -e "process.exit(2)"', purpose: 'lint' }),
    ];
    const results = await runVerificationMatrix(commands, baseContext, store);
    expect(allRequiredCommandsPass(results)).toBe(false);
  });

  it('reports all-pass false for an empty command matrix (nothing was actually verified)', async () => {
    const results = await runVerificationMatrix([], baseContext, store);
    expect(allRequiredCommandsPass(results)).toBe(false);
  });
});
