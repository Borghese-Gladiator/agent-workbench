import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRepositoryMap, type BuildRepositoryMapResult } from './index.js';
import { InMemoryRepositoryMapCache } from './cache.js';
import { makeTmpRepo, writeFixtureFile } from './test-fixtures.js';

describe('buildRepositoryMap', () => {
  let root: string;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds units, symbols, and dependency edges for a small monorepo', async () => {
    root = await makeTmpRepo();
    await writeFixtureFile(root, 'package.json', JSON.stringify({ name: 'monorepo-root', private: true }));
    await writeFixtureFile(
      root,
      'packages/app/package.json',
      JSON.stringify({ name: '@fixture/app', dependencies: { '@fixture/lib': 'workspace:*' } }),
    );
    await writeFixtureFile(
      root,
      'packages/app/src/index.ts',
      "import { helper } from '../../lib/src/index.js';\nexport function main(): number { return helper(); }",
    );
    await writeFixtureFile(root, 'packages/lib/package.json', JSON.stringify({ name: '@fixture/lib' }));
    await writeFixtureFile(root, 'packages/lib/src/index.ts', 'export function helper(): number { return 1; }');
    await writeFixtureFile(root, 'packages/pytool/pyproject.toml', '[project]\nname = "pytool"\n');
    await writeFixtureFile(root, 'packages/pytool/main.py', 'def run():\n    return 1\n');

    const map = await buildRepositoryMap(root, 'sha-123');

    const unitIds = map.units.map((unit) => unit.id).sort();
    expect(unitIds).toEqual(['.', 'packages/app', 'packages/lib', 'packages/pytool'].sort());

    expect(map.unitDependencies).toContainEqual({ from: 'packages/app', to: 'packages/lib' });

    expect(map.symbols.some((symbol) => symbol.name === 'main' && symbol.kind === 'function')).toBe(true);
    expect(map.symbols.some((symbol) => symbol.name === 'helper' && symbol.kind === 'function')).toBe(true);
    expect(map.symbols.some((symbol) => symbol.name === 'run' && symbol.kind === 'function')).toBe(true);

    expect(map.importGraph.length).toBeGreaterThanOrEqual(1);
  });

  it('serves a second build from cache using the same cache key', async () => {
    root = await makeTmpRepo();
    await writeFixtureFile(root, 'package.json', JSON.stringify({ name: 'cached-repo' }));
    await writeFixtureFile(root, 'src/index.ts', 'export function value(): number { return 1; }');

    const cache = new InMemoryRepositoryMapCache<BuildRepositoryMapResult>();
    const first = await buildRepositoryMap(root, 'sha-abc', cache);
    const second = await buildRepositoryMap(root, 'sha-abc', cache);

    expect(second).toBe(first);
    expect(second.cacheKey).toBe(first.cacheKey);
  });

  it('produces a different cache key when the head sha changes', async () => {
    root = await makeTmpRepo();
    await writeFixtureFile(root, 'package.json', JSON.stringify({ name: 'cached-repo' }));
    await writeFixtureFile(root, 'src/index.ts', 'export function value(): number { return 1; }');

    const first = await buildRepositoryMap(root, 'sha-one');
    const second = await buildRepositoryMap(root, 'sha-two');

    expect(first.cacheKey).not.toBe(second.cacheKey);
  });
});
