import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDatabase, type WorkbenchDatabase } from './connection.js';
import * as schema from './schema/index.js';
import { searchRepositoryFacts, searchFindings, searchMemoryEntries } from './fts.js';

describe('FTS5 search', () => {
  let tmpDir: string;
  let handle: WorkbenchDatabase;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'awb-db-fts-'));
    handle = createDatabase(join(tmpDir, 'workbench.sqlite'));

    await handle.db.insert(schema.repositories).values({
      id: 'repo-1',
      canonicalPath: '/tmp/repo-1',
      name: 'repo-1',
      defaultBranch: 'main',
      trusted: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    await handle.db.insert(schema.tasks).values({
      id: 'task-1',
      repositoryId: 'repo-1',
      prompt: 'do the thing',
      phase: 'implement',
      condition: 'running',
      deliveryState: 'not-started',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
  });

  afterEach(() => {
    handle.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds repository facts by keyword', async () => {
    await handle.db.insert(schema.repositoryFacts).values([
      {
        id: 'fact-1',
        repositoryId: 'repo-1',
        kind: 'convention',
        statement: 'the repository uses drizzle orm for database access',
        confidence: 'validated',
        observedAtSha: 'abc123',
        sourcePathsJson: '[]',
        sourceHashesJson: '[]',
        invalidatedByPathsJson: '[]',
      },
      {
        id: 'fact-2',
        repositoryId: 'repo-1',
        kind: 'testing',
        statement: 'tests run via vitest',
        confidence: 'validated',
        observedAtSha: 'abc123',
        sourcePathsJson: '[]',
        sourceHashesJson: '[]',
        invalidatedByPathsJson: '[]',
      },
    ]);

    const results = searchRepositoryFacts(handle.sqlite, 'repo-1', 'drizzle');
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('fact-1');

    const noMatch = searchRepositoryFacts(handle.sqlite, 'repo-1', 'kubernetes');
    expect(noMatch).toHaveLength(0);
  });

  it('finds findings by keyword', async () => {
    await handle.db.insert(schema.findings).values([
      {
        id: 'finding-1',
        taskId: 'task-1',
        severity: 'high',
        category: 'correctness',
        claimIdsJson: '[]',
        description: 'off by one error in pagination logic',
        status: 'open',
      },
      {
        id: 'finding-2',
        taskId: 'task-1',
        severity: 'low',
        category: 'maintainability',
        claimIdsJson: '[]',
        description: 'variable naming could be clearer',
        status: 'open',
      },
    ]);

    const results = searchFindings(handle.sqlite, 'task-1', 'pagination');
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('finding-1');
  });

  it('finds memory entries by keyword and reflects updates', async () => {
    await handle.db.insert(schema.memoryEntries).values({
      id: 'memory-1',
      repositoryId: 'repo-1',
      title: 'gotcha',
      body: 'watch out for the flaky retry logic',
      kind: 'pitfall',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    let results = searchMemoryEntries(handle.sqlite, 'flaky');
    expect(results).toHaveLength(1);

    await handle.db
      .update(schema.memoryEntries)
      .set({ body: 'nothing interesting here' })
      .where(eq(schema.memoryEntries.id, 'memory-1'));

    results = searchMemoryEntries(handle.sqlite, 'flaky');
    expect(results).toHaveLength(0);

    results = searchMemoryEntries(handle.sqlite, 'interesting');
    expect(results).toHaveLength(1);
  });
});
