import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type WorkbenchDatabase } from '@awb/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repositoryFacts } from '@awb/database';
import { eq } from 'drizzle-orm';
import type { RepositoryFact } from '@awb/domain';
import {
  registerRepository,
  approveRepository,
  getRepository,
  listRepositories,
  refreshRepositorySnapshot,
  getLatestSnapshot,
  persistDiscoveryFacts,
} from './persist.js';
import { makeTempRepo, writeFileEnsuringDir, commitAll } from './test-helpers.js';

describe('repository persistence', () => {
  let repoDir: string;
  let dbDir: string;
  let database: WorkbenchDatabase;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    dbDir = await mkdtemp(join(tmpdir(), 'awb-db-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
  });

  afterEach(async () => {
    database.close();
    await rm(repoDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('registers a repository as untrusted', async () => {
    await writeFileEnsuringDir(repoDir, 'package.json', JSON.stringify({ name: 'demo' }));
    await commitAll(repoDir, 'init');

    const repo = await registerRepository(database.db, { canonicalPath: repoDir });
    expect(repo.trusted).toBe(false);
    expect(repo.defaultBranch).toBe('main');

    const fetched = await getRepository(database.db, repo.id);
    expect(fetched?.canonicalPath).toBe(repoDir);
  });

  it('rejects registering a non-git directory', async () => {
    await expect(registerRepository(database.db, { canonicalPath: dbDir })).rejects.toThrow();
  });

  it('lists all registered repositories', async () => {
    await writeFileEnsuringDir(repoDir, 'package.json', JSON.stringify({ name: 'demo' }));
    await commitAll(repoDir, 'init');
    await registerRepository(database.db, { canonicalPath: repoDir });
    expect(await listRepositories(database.db)).toHaveLength(1);
  });

  it('approves a repository, flipping trusted to true', async () => {
    await writeFileEnsuringDir(repoDir, 'package.json', JSON.stringify({ name: 'demo' }));
    await commitAll(repoDir, 'init');
    const repo = await registerRepository(database.db, { canonicalPath: repoDir });
    await approveRepository(database.db, repo.id);
    const fetched = await getRepository(database.db, repo.id);
    expect(fetched?.trusted).toBe(true);
  });

  it('refreshes and persists a full repository snapshot', async () => {
    await writeFileEnsuringDir(
      repoDir,
      'package.json',
      JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', start: 'node server.js' } }),
    );
    await commitAll(repoDir, 'init');

    const repo = await registerRepository(database.db, { canonicalPath: repoDir });
    const snapshot = await refreshRepositorySnapshot(database.db, repo);

    expect(snapshot.units.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.commands.some((c) => c.purpose === 'unit-test')).toBe(true);

    const latest = await getLatestSnapshot(database.db, repo.id);
    expect(latest?.headSha).toBe(snapshot.headSha);
  });

  it('persistDiscoveryFacts replaces prior discovery facts but preserves compiled concepts', async () => {
    await writeFileEnsuringDir(repoDir, 'package.json', JSON.stringify({ name: 'demo' }));
    await commitAll(repoDir, 'init');
    const repo = await registerRepository(database.db, { canonicalPath: repoDir });

    const mkFact = (over: Partial<RepositoryFact> & Pick<RepositoryFact, 'id' | 'kind'>): RepositoryFact => ({
      repositoryId: repo.id,
      statement: 's',
      confidence: 'inferred',
      observedAtSha: 'sha',
      sourcePaths: ['README.md'],
      sourceHashes: ['h'],
      invalidatedByPaths: [],
      ...over,
    });

    // Seed: one discovery fact + one compiled concept.
    await persistDiscoveryFacts(database.db, repo.id, [
      mkFact({ id: 'd1', kind: 'architecture', statement: 'old discovery fact' }),
      mkFact({ id: 'c1', kind: 'concept', statement: 'compiled concept' }),
    ]);

    // Re-run discovery with a NEW fact set (no d1). The concept must survive; d1 must be gone.
    await persistDiscoveryFacts(database.db, repo.id, [
      mkFact({ id: 'd2', kind: 'architecture', statement: 'new discovery fact' }),
    ]);

    const rows = await database.db.select().from(repositoryFacts).where(eq(repositoryFacts.repositoryId, repo.id));
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['c1', 'd2']);
  });
});
