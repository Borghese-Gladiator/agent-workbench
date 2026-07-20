import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import { runLibraryQa } from './library-qa.js';
import { makeQaEvidenceContext } from './test-helpers.js';

describe('runLibraryQa', () => {
  let root: string;
  let store: ArtifactStore;
  let libDir: string;
  let libPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'awb-qa-library-store-'));
    store = new ArtifactStore(root, new InMemoryArtifactMetadataStore());
    libDir = await mkdtemp(join(tmpdir(), 'awb-qa-library-target-'));
    libPath = join(libDir, 'add.mjs');
    await writeFile(libPath, 'export function add(a, b) { return a + b; }\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(libDir, { recursive: true, force: true });
  });

  it('runs a real consumer script importing a real library and parses passing ASSERT markers', async () => {
    const consumerScriptSource = `
import { add } from ${JSON.stringify(libPath)};
const result = add(2, 3);
console.log("ASSERT:add-returns-five=" + (result === 5));
console.log("ASSERT:add-is-number=" + (typeof result === "number"));
`;

    const result = await runLibraryQa(
      { consumerScriptSource },
      makeQaEvidenceContext(),
      store,
    );

    expect(result.exitCode).toBe(0);
    expect(result.assertions).toHaveLength(2);
    expect(result.assertions.every((a) => a.passed)).toBe(true);
    expect(result.evidence.status).toBe('passed');
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.some((a) => a.kind === 'terminal-recording')).toBe(true);
    expect(result.artifacts.some((a) => a.kind === 'other')).toBe(true);
  });

  it('fails when a real ASSERT marker reports false against real library behavior', async () => {
    const consumerScriptSource = `
import { add } from ${JSON.stringify(libPath)};
const result = add(2, 3);
console.log("ASSERT:add-returns-wrong-value=" + (result === 999));
`;

    const result = await runLibraryQa(
      { consumerScriptSource },
      makeQaEvidenceContext(),
      store,
    );

    expect(result.exitCode).toBe(0);
    expect(result.assertions[0]?.passed).toBe(false);
    expect(result.evidence.status).toBe('failed');
  });

  it('is inconclusive when the consumer script throws before printing any markers', async () => {
    const consumerScriptSource = `
throw new Error("boom before assertions");
`;

    const result = await runLibraryQa(
      { consumerScriptSource },
      makeQaEvidenceContext(),
      store,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]?.passed).toBe(false);
    expect(result.evidence.status).toBe('inconclusive');
  });
});
