import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, repositories, type WorkbenchDatabase } from '@awb/database';

export interface TestDb {
  handle: WorkbenchDatabase;
  tmpDir: string;
}

export function makeTestDb(prefix: string): TestDb {
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));
  const handle = createDatabase(join(tmpDir, 'workbench.sqlite'));
  return { handle, tmpDir };
}

export function cleanupTestDb({ handle, tmpDir }: TestDb): void {
  handle.close();
  rmSync(tmpDir, { recursive: true, force: true });
}

export async function seedRepository(handle: WorkbenchDatabase, repositoryId: string): Promise<void> {
  await handle.db.insert(repositories).values({
    id: repositoryId,
    canonicalPath: `/tmp/${repositoryId}`,
    name: repositoryId,
    defaultBranch: 'main',
    trusted: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
}
