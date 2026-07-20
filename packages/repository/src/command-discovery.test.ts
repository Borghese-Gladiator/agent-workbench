import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverPackageJsonCommands,
  discoverMakefileCommands,
  discoverCiCommands,
  discoverPythonCommands,
  discoverCommands,
} from './command-discovery.js';
import { makeTempRepo, writeFileEnsuringDir } from './test-helpers.js';

describe('command discovery', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discovers package.json scripts with correct purpose classification', async () => {
    await writeFileEnsuringDir(
      dir,
      'package.json',
      JSON.stringify({
        name: 'demo',
        packageManager: 'pnpm@9.0.0',
        scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc' },
      }),
    );
    const commands = await discoverPackageJsonCommands(dir);
    expect(commands.find((c) => c.command.includes('test'))?.purpose).toBe('unit-test');
    expect(commands.find((c) => c.command.includes('lint'))?.purpose).toBe('lint');
    expect(commands.find((c) => c.command.includes('build'))?.purpose).toBe('build');
    expect(commands.every((c) => c.source === 'package-script')).toBe(true);
    expect(commands.every((c) => c.command.startsWith('pnpm '))).toBe(true);
  });

  it('discovers Makefile targets', async () => {
    await writeFileEnsuringDir(dir, 'Makefile', 'test:\n\tpytest\n\nlint:\n\truff check .\n');
    const commands = await discoverMakefileCommands(dir);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.source).toBe('makefile');
  });

  it('discovers commands from a GitHub Actions workflow', async () => {
    await writeFileEnsuringDir(
      dir,
      '.github/workflows/ci.yml',
      'jobs:\n  test:\n    steps:\n      - run: pnpm test\n      - run: pnpm lint\n',
    );
    const commands = await discoverCiCommands(dir);
    expect(commands.map((c) => c.command)).toEqual(['pnpm test', 'pnpm lint']);
    expect(commands.every((c) => c.source === 'ci')).toBe(true);
  });

  it('discovers Python commands from pyproject.toml tool sections', async () => {
    await writeFileEnsuringDir(
      dir,
      'pyproject.toml',
      '[tool.pytest.ini_options]\n\n[tool.ruff]\n\n[tool.poetry]\nname = "demo"\n',
    );
    const commands = await discoverPythonCommands(dir);
    expect(commands.find((c) => c.purpose === 'unit-test')?.command).toBe('pytest');
    expect(commands.find((c) => c.purpose === 'lint')?.command).toBe('ruff check .');
    expect(commands.find((c) => c.purpose === 'install')?.command).toBe('poetry install');
    expect(commands.every((c) => c.source === 'inferred')).toBe(true);
  });

  it('CI commands take priority over package.json scripts for the same purpose', async () => {
    await writeFileEnsuringDir(
      dir,
      '.github/workflows/ci.yml',
      'jobs:\n  test:\n    steps:\n      - run: pnpm run test:ci\n',
    );
    await writeFileEnsuringDir(
      dir,
      'package.json',
      JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }),
    );
    const commands = await discoverCommands(dir);
    const unitTestCommands = commands.filter((c) => c.purpose === 'unit-test');
    expect(unitTestCommands).toHaveLength(1);
    expect(unitTestCommands[0]?.source).toBe('ci');
  });
});
