import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverUnits } from './units.js';
import { makeTmpRepo, writeFixtureFile } from './test-fixtures.js';

describe('discoverUnits', () => {
  let root: string;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers a single TypeScript package at the repo root', async () => {
    root = await makeTmpRepo();
    await writeFixtureFile(
      root,
      'package.json',
      JSON.stringify({ name: 'my-ts-lib', dependencies: {} }),
    );
    await writeFixtureFile(root, 'src/index.ts', 'export function greet(): string { return "hi"; }');

    const units = discoverUnits(root);

    expect(units).toHaveLength(1);
    expect(units[0]?.language).toBe('typescript');
    expect(units[0]?.id).toBe('.');
  });

  it('discovers a single Python package at the repo root', async () => {
    root = await makeTmpRepo();
    await writeFixtureFile(root, 'pyproject.toml', '[project]\nname = "my-py-lib"\n');
    await writeFixtureFile(root, 'my_py_lib/__init__.py', 'def greet():\n    return "hi"\n');

    const units = discoverUnits(root);

    expect(units).toHaveLength(1);
    expect(units[0]?.language).toBe('python');
  });

  it('discovers a monorepo with two units and a workspace dependency', async () => {
    root = await makeTmpRepo();
    await writeFixtureFile(
      root,
      'package.json',
      JSON.stringify({ name: 'monorepo-root', private: true }),
    );
    await writeFixtureFile(
      root,
      'packages/app/package.json',
      JSON.stringify({
        name: '@fixture/app',
        dependencies: { '@fixture/lib': 'workspace:*' },
      }),
    );
    await writeFixtureFile(root, 'packages/app/src/index.ts', 'export const main = () => 1;');
    await writeFixtureFile(
      root,
      'packages/lib/package.json',
      JSON.stringify({ name: '@fixture/lib' }),
    );
    await writeFixtureFile(root, 'packages/lib/src/index.ts', 'export function helper(): number { return 1; }');

    const units = discoverUnits(root);
    const unitIds = units.map((unit) => unit.id).sort();

    expect(unitIds).toEqual(['.', 'packages/app', 'packages/lib'].sort());

    const appUnit = units.find((unit) => unit.id === 'packages/app');
    expect(appUnit?.dependsOn).toContain('packages/lib');
  });

  it('infers cli kind from a bin field', async () => {
    root = await makeTmpRepo();
    await writeFixtureFile(
      root,
      'package.json',
      JSON.stringify({ name: 'my-cli', bin: { 'my-cli': './bin.js' } }),
    );

    const units = discoverUnits(root);
    expect(units[0]?.kind).toBe('cli');
  });

  it('infers web kind from a react dependency', async () => {
    root = await makeTmpRepo();
    await writeFixtureFile(
      root,
      'package.json',
      JSON.stringify({ name: 'my-web-app', dependencies: { react: '^18.0.0' } }),
    );

    const units = discoverUnits(root);
    expect(units[0]?.kind).toBe('web');
  });

  it('infers cli kind for a python package with a __main__.py entrypoint', async () => {
    root = await makeTmpRepo();
    await writeFixtureFile(root, 'pyproject.toml', '[project]\nname = "my-py-cli"\n');
    await writeFixtureFile(root, 'my_py_cli/__main__.py', 'print("hi")\n');

    const units = discoverUnits(root);
    expect(units[0]?.kind).toBe('cli');
  });
});
