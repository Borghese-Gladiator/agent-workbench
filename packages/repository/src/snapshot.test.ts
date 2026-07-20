import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRepositorySnapshot, markAmbiguousDuplicates } from './snapshot.js';
import { discoverUnits } from './units.js';
import { makeTempRepo, writeFileEnsuringDir, commitAll } from './test-helpers.js';
import type { ValidatedCommand } from '@awb/domain';

describe('discoverUnits', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('treats a single package.json repo root as one unit', async () => {
    await writeFileEnsuringDir(
      dir,
      'package.json',
      JSON.stringify({ name: 'simple-ts', scripts: { start: 'node index.js' } }),
    );
    await commitAll(dir, 'init');
    const units = await discoverUnits(dir);
    expect(units).toHaveLength(1);
    expect(units[0]?.language).toBe('typescript');
  });

  it('detects a monorepo with two units and a workspace dependency', async () => {
    await writeFileEnsuringDir(
      dir,
      'apps/web/package.json',
      JSON.stringify({ name: 'web-app', dependencies: { 'shared-lib': 'workspace:*' }, scripts: { start: 'vite' } }),
    );
    await writeFileEnsuringDir(dir, 'apps/web/index.html', '<html></html>');
    await writeFileEnsuringDir(
      dir,
      'packages/shared-lib/package.json',
      JSON.stringify({ name: 'shared-lib' }),
    );
    await commitAll(dir, 'init');

    const units = await discoverUnits(dir);
    expect(units).toHaveLength(2);
    const webUnit = units.find((u) => u.root === 'apps/web');
    const libUnit = units.find((u) => u.root === 'packages/shared-lib');
    expect(webUnit?.kind).toBe('web');
    expect(libUnit?.kind).toBe('library');
    expect(webUnit?.dependsOn).toEqual([libUnit?.id]);
  });

  it('detects a simple Python package', async () => {
    await writeFileEnsuringDir(dir, 'pyproject.toml', '[tool.poetry]\nname = "demo"\n');
    await commitAll(dir, 'init');
    const units = await discoverUnits(dir);
    expect(units).toHaveLength(1);
    expect(units[0]?.language).toBe('python');
  });
});

describe('markAmbiguousDuplicates', () => {
  it('marks duplicate non-validated commands for the same purpose as ambiguous', () => {
    const commands: ValidatedCommand[] = [
      {
        id: '1',
        repositoryId: 'repo',
        purpose: 'lint',
        command: 'eslint .',
        cwd: '.',
        source: 'package-script',
        status: 'declared',
      },
      {
        id: '2',
        repositoryId: 'repo',
        purpose: 'lint',
        command: 'ruff check .',
        cwd: '.',
        source: 'inferred',
        status: 'inferred',
      },
    ];
    const result = markAmbiguousDuplicates(commands);
    expect(result.every((c) => c.status === 'ambiguous')).toBe(true);
  });

  it('does not mark a validated command as ambiguous even if a duplicate purpose exists', () => {
    const commands: ValidatedCommand[] = [
      {
        id: '1',
        repositoryId: 'repo',
        purpose: 'lint',
        command: 'eslint .',
        cwd: '.',
        source: 'package-script',
        status: 'validated',
      },
      {
        id: '2',
        repositoryId: 'repo',
        purpose: 'lint',
        command: 'ruff check .',
        cwd: '.',
        source: 'inferred',
        status: 'inferred',
      },
    ];
    const result = markAmbiguousDuplicates(commands);
    expect(result.find((c) => c.id === '1')?.status).toBe('validated');
    expect(result.find((c) => c.id === '2')?.status).toBe('ambiguous');
  });

  it('leaves a unique-purpose command untouched', () => {
    const commands: ValidatedCommand[] = [
      {
        id: '1',
        repositoryId: 'repo',
        purpose: 'build',
        command: 'tsc',
        cwd: '.',
        source: 'package-script',
        status: 'declared',
      },
    ];
    expect(markAmbiguousDuplicates(commands)[0]?.status).toBe('declared');
  });
});

describe('buildRepositorySnapshot', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('builds a full snapshot with units, commands, services, qa surfaces, and facts', async () => {
    await writeFileEnsuringDir(
      dir,
      'package.json',
      JSON.stringify({
        name: 'demo',
        scripts: { start: 'node server.js', test: 'vitest run' },
      }),
    );
    await writeFileEnsuringDir(dir, 'CLAUDE.md', '# agent guide');
    await commitAll(dir, 'init');

    const snapshot = await buildRepositorySnapshot({ rootDir: dir, repositoryId: 'repo-1' });

    expect(snapshot.headSha).toHaveLength(40);
    expect(snapshot.units.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.commands.some((c) => c.purpose === 'unit-test')).toBe(true);
    expect(snapshot.services.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.qaSurfaces.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.facts.some((f) => f.sourcePaths.includes('CLAUDE.md'))).toBe(true);
  });
});
