import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type WorkbenchDatabase } from '@awb/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  registerRepository,
  approveRepository,
  getRepository,
  listRepositories,
  refreshRepositorySnapshot,
  getLatestSnapshot,
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
});
