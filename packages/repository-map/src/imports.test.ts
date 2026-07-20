import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { extractImportEdges } from './imports.js';
import { makeTmpRepo, writeFixtureFile } from './test-fixtures.js';

describe('extractImportEdges', () => {
  let root: string;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures an edge for a relative import between two TS files', async () => {
    root = await makeTmpRepo();
    await writeFixtureFile(root, 'b.ts', 'export const value = 1;');
    const aPath = await writeFixtureFile(root, 'a.ts', "import { value } from './b.js';\nconsole.log(value);");

    const source = "import { value } from './b.js';\nconsole.log(value);";
    const edges = await extractImportEdges(aPath, source, 'typescript');

    expect(edges).toHaveLength(1);
    expect(edges[0]?.from).toBe(aPath);
    expect(edges[0]?.to).toContain('b.ts');
  });

  it('produces no edges for imports that do not resolve to a file on disk', async () => {
    root = await makeTmpRepo();
    const aPath = await writeFixtureFile(root, 'a.ts', "import { thing } from 'external-package';");

    const edges = await extractImportEdges(aPath, "import { thing } from 'external-package';", 'typescript');

    expect(edges).toHaveLength(0);
  });

  it('returns no edges for python (import graph is TS-only for the MVP)', async () => {
    const edges = await extractImportEdges('a.py', 'import os', 'python');
    expect(edges).toHaveLength(0);
  });
});
