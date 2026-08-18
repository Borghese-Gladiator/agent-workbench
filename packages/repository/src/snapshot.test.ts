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

  it('includes the root unit and workspace-glob packages outside the container dirs (TASK-8)', async () => {
    await writeFileEnsuringDir(
      dir,
      'package.json',
      JSON.stringify({
        name: 'browser-games',
        private: true,
        workspaces: ['packages/engines/*', 'games/*'],
        scripts: { test: 'vitest run', build: 'vite build' },
        dependencies: { react: '^18.0.0' },
      }),
    );
    // A nested workspace package (packages/engines/*) and one outside the conventional containers
    // (games/*) — neither is reachable by the hardcoded container scan alone.
    await writeFileEnsuringDir(
      dir,
      'packages/engines/poker/package.json',
      JSON.stringify({ name: '@bg/engine-poker' }),
    );
    await writeFileEnsuringDir(dir, 'games/poker/package.json', JSON.stringify({ name: '@bg/game-poker' }));
    await commitAll(dir, 'init');

    const units = await discoverUnits(dir);
    const roots = units.map((u) => u.root);
    expect(roots).toContain('.');
    expect(roots).toContain('packages/engines/poker');
    expect(roots).toContain('games/poker');
  });

  it('discovers the root package.json verification commands in a workspace repo (TASK-8)', async () => {
    await writeFileEnsuringDir(
      dir,
      'package.json',
      JSON.stringify({
        name: 'browser-games',
        private: true,
        workspaces: ['packages/engines/*'],
        scripts: { test: 'vitest run', build: 'vite build' },
      }),
    );
    // The engine sub-package carries no scripts of its own — tests run from the root, exactly the
    // wip-browser-games shape that made refresh discover 0 verification commands before the fix.
    await writeFileEnsuringDir(
      dir,
      'packages/engines/poker/package.json',
      JSON.stringify({ name: '@bg/engine-poker' }),
    );
    await commitAll(dir, 'init');

    const snapshot = await buildRepositorySnapshot({ rootDir: dir, repositoryId: 'repo-ws' });
    expect(snapshot.commands.some((c) => c.purpose === 'unit-test')).toBe(true);
    expect(snapshot.commands.some((c) => c.purpose === 'build')).toBe(true);
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
    // Discovered commands become facts the planner sees through project memory (the `test`/`start`
    // scripts surface as a `testing` and a `command` fact respectively).
    expect(snapshot.facts.some((f) => f.kind === 'testing')).toBe(true);
    expect(snapshot.facts.some((f) => f.kind === 'command')).toBe(true);
    // Fact source paths stay repo-relative, never absolute temp paths.
    const cmdFact = snapshot.facts.find((f) => f.kind === 'command');
    expect(cmdFact?.sourcePaths.every((p) => !p.startsWith('/'))).toBe(true);
  });

  it('sets hasExistingFrontend true when a web unit is detected', async () => {
    await writeFileEnsuringDir(
      dir,
      'package.json',
      JSON.stringify({ name: 'web-app', dependencies: { react: '^18.0.0' } }),
    );
    await writeFileEnsuringDir(dir, 'index.html', '<html></html>');
    await commitAll(dir, 'init');

    const snapshot = await buildRepositorySnapshot({ rootDir: dir, repositoryId: 'repo-web' });
    expect(snapshot.hasExistingFrontend).toBe(true);
  });

  it('sets hasExistingFrontend false for a non-frontend repo', async () => {
    await writeFileEnsuringDir(dir, 'package.json', JSON.stringify({ name: 'cli-tool' }));
    await commitAll(dir, 'init');

    const snapshot = await buildRepositorySnapshot({ rootDir: dir, repositoryId: 'repo-cli' });
    expect(snapshot.hasExistingFrontend).toBe(false);
  });

  it('enterprise repos short-circuit hasExistingFrontend to true and skip command discovery', async () => {
    await writeFileEnsuringDir(dir, 'package.json', JSON.stringify({ name: 'cli-tool', scripts: { test: 'vitest run' } }));
    await commitAll(dir, 'init');

    const snapshot = await buildRepositorySnapshot({ rootDir: dir, repositoryId: 'repo-ent', isEnterpriseRepo: true });
    expect(snapshot.hasExistingFrontend).toBe(true);
    expect(snapshot.commands).toEqual([]);
  });
});
