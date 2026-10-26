import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import { runCliQa } from './cli-qa.js';
import { makeQaEvidenceContext } from './test-helpers.js';

describe('runCliQa', () => {
  let root: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'awb-qa-cli-'));
    store = new ArtifactStore(root, new InMemoryArtifactMetadataStore());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs a real node process and passes when expectations match real output', async () => {
    const result = await runCliQa(
      {
        command: 'node',
        args: ['-e', "console.log('hello'); process.exit(0)"],
        cwd: root,
        env: { PATH: process.env.PATH ?? '' },
        expectations: [
          { kind: 'stdoutContains', text: 'hello' },
          { kind: 'exitCode', equals: 0 },
        ],
      },
      makeQaEvidenceContext(),
      store,
    );

    expect(result.exitCode).toBe(0);
    expect(result.assertions.every((a) => a.passed)).toBe(true);
    expect(result.evidence.status).toBe('passed');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.kind).toBe('terminal-recording');

    const stored = store.get(result.artifacts[0]!.id);
    expect(stored).toBeDefined();
  });

  it('fails when a real assertion does not match the real captured output', async () => {
    const result = await runCliQa(
      {
        command: 'node',
        args: ['-e', "console.log('goodbye'); process.exit(1)"],
        cwd: root,
        env: { PATH: process.env.PATH ?? '' },
        expectations: [
          { kind: 'stdoutContains', text: 'hello' },
          { kind: 'exitCode', equals: 0 },
        ],
      },
      makeQaEvidenceContext(),
      store,
    );

    expect(result.exitCode).toBe(1);
    expect(result.assertions.some((a) => !a.passed)).toBe(true);
    expect(result.evidence.status).toBe('failed');
  });

  it('captures real stderr and exit code from a failing command', async () => {
    const result = await runCliQa(
      {
        command: 'node',
        args: ['-e', "console.error('boom'); process.exit(2)"],
        cwd: root,
        env: { PATH: process.env.PATH ?? '' },
        expectations: [{ kind: 'stderrContains', text: 'boom' }],
      },
      makeQaEvidenceContext(),
      store,
    );

    expect(result.exitCode).toBe(2);
    expect(result.assertions[0]?.passed).toBe(true);
    expect(result.evidence.status).toBe('passed');
  });
});
