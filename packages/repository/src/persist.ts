import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  repositories,
  repositorySnapshots,
  repositoryUnits,
  repositoryCommands,
  repositoryServices,
  repositoryQaSurfaces,
  type DrizzleDb,
  type Repository as RepositoryRow,
} from '@awb/database';
import type { Repository, RepositorySnapshot, ValidatedCommand } from '@awb/domain';
import { getDefaultBranch, getRemotes, isGitRepository } from './git.js';
import { buildRepositorySnapshot } from './snapshot.js';

export interface RegisterRepositoryOptions {
  canonicalPath: string;
  name?: string;
}

/**
 * Registers a repository (spec §15 onboarding step 1-2): validates it's a real Git repo, records
 * it in the `repositories` table as untrusted, and returns the row. Does not run full discovery —
 * call `refreshRepositorySnapshot` separately so callers can gate expensive discovery behind
 * explicit confirmation.
 */
export async function registerRepository(
  db: DrizzleDb,
  options: RegisterRepositoryOptions,
): Promise<Repository> {
  if (!(await isGitRepository(options.canonicalPath))) {
    throw new Error(`${options.canonicalPath} is not a Git repository`);
  }

  const remotes = await getRemotes(options.canonicalPath);
  const defaultBranch = await getDefaultBranch(options.canonicalPath);
  const now = new Date().toISOString();
  const name = options.name ?? options.canonicalPath.split('/').filter(Boolean).pop() ?? 'repository';

  const row: RepositoryRow = {
    id: randomUUID(),
    canonicalPath: options.canonicalPath,
    name,
    remoteUrl: remotes[0]?.fetchUrl ?? null,
    defaultBranch,
    trusted: false,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(repositories).values(row);
  return rowToRepository(row);
}

function rowToRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    canonicalPath: row.canonicalPath,
    name: row.name,
    remoteUrl: row.remoteUrl ?? undefined,
    defaultBranch: row.defaultBranch,
    trusted: row.trusted,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getRepository(db: DrizzleDb, repositoryId: string): Promise<Repository | undefined> {
  const rows = await db.select().from(repositories).where(eq(repositories.id, repositoryId));
  const row = rows[0];
  return row ? rowToRepository(row) : undefined;
}

export async function listRepositories(db: DrizzleDb): Promise<Repository[]> {
  const rows = await db.select().from(repositories);
  return rows.map(rowToRepository);
}

export async function approveRepository(db: DrizzleDb, repositoryId: string): Promise<void> {
  await db
    .update(repositories)
    .set({ trusted: true, updatedAt: new Date().toISOString() })
    .where(eq(repositories.id, repositoryId));
}

/**
 * Runs full discovery for a repository and persists the resulting snapshot (spec §15-16 steps
 * 2-6). Safe to call repeatedly — each call inserts a new snapshot row rather than mutating a
 * prior one, since snapshots are point-in-time by design.
 */
export async function refreshRepositorySnapshot(
  db: DrizzleDb,
  repository: Repository,
): Promise<RepositorySnapshot> {
  const snapshot = await buildRepositorySnapshot({
    rootDir: repository.canonicalPath,
    repositoryId: repository.id,
  });

  await db.insert(repositorySnapshots).values({
    id: snapshot.id,
    repositoryId: repository.id,
    headSha: snapshot.headSha,
    createdAt: snapshot.createdAt,
    repositoryMapArtifactId: snapshot.repositoryMapArtifactId,
  });

  for (const unit of snapshot.units) {
    await db.insert(repositoryUnits).values({
      id: unit.id,
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      root: unit.root,
      language: unit.language,
      kind: unit.kind,
      framework: unit.framework,
      packageManager: unit.packageManager,
      dependsOnJson: JSON.stringify(unit.dependsOn),
    });
  }

  for (const command of snapshot.commands) {
    await db.insert(repositoryCommands).values({
      id: command.id,
      repositoryId: repository.id,
      unitId: command.unitId,
      purpose: command.purpose,
      command: command.command,
      cwd: command.cwd,
      source: command.source,
      status: command.status,
      validatedAtSha: command.validatedAtSha,
      lastExitCode: command.lastExitCode,
    });
  }

  for (const service of snapshot.services) {
    await db.insert(repositoryServices).values({
      id: service.id,
      repositoryId: repository.id,
      unitId: service.unitId,
      name: service.name,
      kind: service.kind,
      startCommandId: service.startCommandId,
      healthcheckCommandId: service.healthcheckCommandId,
      defaultPort: service.defaultPort,
    });
  }

  for (const qaSurface of snapshot.qaSurfaces) {
    await db.insert(repositoryQaSurfaces).values({
      id: qaSurface.id,
      repositoryId: repository.id,
      unitId: qaSurface.unitId,
      kind: qaSurface.kind,
      entrypoint: qaSurface.entrypoint,
      description: qaSurface.description,
    });
  }

  await db
    .update(repositories)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(repositories.id, repository.id));

  return snapshot;
}

export async function getLatestSnapshot(
  db: DrizzleDb,
  repositoryId: string,
): Promise<{ id: string; headSha: string; createdAt: string } | undefined> {
  const rows = await db
    .select()
    .from(repositorySnapshots)
    .where(eq(repositorySnapshots.repositoryId, repositoryId));
  if (rows.length === 0) return undefined;
  return rows.reduce((latest, row) => (row.createdAt > latest.createdAt ? row : latest));
}

/**
 * Rehydrates the ValidatedCommands persisted for a repository. `getLatestSnapshot` returns only the
 * snapshot header row; this loads the discovered commands (test/build/lint/etc.) back out of
 * `repository_commands` so callers (e.g. the verify/exercise Activities) can run the repo's real
 * commands instead of a hardcoded placeholder. Keyed by repositoryId — the commands table has no
 * snapshotId column, and a freshly-registered repo is refreshed once, so this returns that repo's
 * discovered command set. Returns [] when nothing was discovered.
 */
export async function getRepositoryCommands(db: DrizzleDb, repositoryId: string): Promise<ValidatedCommand[]> {
  const rows = await db
    .select()
    .from(repositoryCommands)
    .where(eq(repositoryCommands.repositoryId, repositoryId));
  return rows.map((row) => ({
    id: row.id,
    repositoryId: row.repositoryId,
    unitId: row.unitId ?? undefined,
    purpose: row.purpose,
    command: row.command,
    cwd: row.cwd,
    source: row.source,
    status: row.status,
    validatedAtSha: row.validatedAtSha ?? undefined,
    lastExitCode: row.lastExitCode ?? undefined,
  }));
}
