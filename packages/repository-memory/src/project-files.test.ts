import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { RepositoryFact } from '@awb/domain';
import { recordFacts } from './store.js';
import { invalidateFacts } from './invalidate.js';
import { projectMemoryToFiles } from './project-files.js';
import { makeTestDb, cleanupTestDb, seedRepository, type TestDb } from './test-helpers.js';

function fact(overrides: Partial<RepositoryFact> & Pick<RepositoryFact, 'id' | 'kind'>): RepositoryFact {
  return {
    repositoryId: 'repo-1',
    statement: 'placeholder',
    confidence: 'validated',
    observedAtSha: 'sha-1',
    sourcePaths: ['src/x.ts'],
    sourceHashes: ['h'],
    invalidatedByPaths: [],
    ...overrides,
  };
}

describe('projectMemoryToFiles', () => {
  let testDb: TestDb;
  let outDir: string;

  beforeEach(async () => {
    testDb = makeTestDb('awb-repomem-files-');
    outDir = mkdtempSync(join(tmpdir(), 'awb-memfiles-'));
    await seedRepository(testDb.handle, 'repo-1');
  });

  afterEach(() => {
    cleanupTestDb(testDb);
    rmSync(outDir, { recursive: true, force: true });
  });

  it('projects facts to per-theme pages with provenance and an index', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'p1', kind: 'pitfall', statement: 'clicking Join opens N sockets', sourcePaths: ['src/net.ts'] }),
      fact({ id: 'cmd1', kind: 'command', statement: 'build with pnpm build', sourcePaths: ['package.json'] }),
    ]);

    const result = await projectMemoryToFiles(testDb.handle.db, testDb.handle.sqlite, 'repo-1', outDir);

    expect(result.pagesWritten).toContain('pitfalls.md');
    expect(result.pagesWritten).toContain('commands.md');
    expect(result.pagesWritten).toContain('README.md');

    const pitfalls = readFileSync(join(outDir, 'pitfalls.md'), 'utf8');
    expect(pitfalls).toContain('clicking Join opens N sockets');
    expect(pitfalls).toContain('src/net.ts'); // provenance rendered
    const readme = readFileSync(join(outDir, 'README.md'), 'utf8');
    expect(readme).toContain('Pitfalls');
  });

  it('keeps superseded facts under a Superseded section (never silently dropped)', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'i1', kind: 'invariant', statement: 'stays live', sourcePaths: ['src/keep.ts'] }),
      fact({ id: 'i2', kind: 'invariant', statement: 'gets superseded', sourcePaths: ['src/gone.ts'] }),
    ]);
    await invalidateFacts(testDb.handle.db, 'repo-1', ['src/gone.ts']);

    await projectMemoryToFiles(testDb.handle.db, testDb.handle.sqlite, 'repo-1', outDir);
    const rules = readFileSync(join(outDir, 'rules.md'), 'utf8');
    expect(rules).toContain('stays live');
    expect(rules).toContain('## Superseded');
    expect(rules).toContain('gets superseded');
  });

  it('regenerates wholesale — a page with no facts does not linger', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [fact({ id: 'p1', kind: 'pitfall', statement: 'x' })]);
    await projectMemoryToFiles(testDb.handle.db, testDb.handle.sqlite, 'repo-1', outDir);
    expect(readdirSync(outDir)).toContain('pitfalls.md');

    // Second run with no pitfall facts should drop the stale page. Delete the provenance join first
    // (FK), then the facts.
    testDb.handle.sqlite.prepare('DELETE FROM repository_fact_sources').run();
    testDb.handle.sqlite.prepare('DELETE FROM repository_facts').run();
    await recordFacts(testDb.handle.db, 'repo-1', [fact({ id: 'c1', kind: 'command', statement: 'y' })]);
    await projectMemoryToFiles(testDb.handle.db, testDb.handle.sqlite, 'repo-1', outDir);
    const files = readdirSync(outDir);
    expect(files).not.toContain('pitfalls.md');
    expect(files).toContain('commands.md');
  });
});
