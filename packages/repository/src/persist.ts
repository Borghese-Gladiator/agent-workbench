import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { inArray } from 'drizzle-orm';
import {
  repositories,
  repositorySnapshots,
  repositoryUnits,
  repositoryCommands,
  repositoryServices,
  repositoryQaSurfaces,
  repositoryFacts,
  repositoryFactSources,
  repositorySymbols,
  repositoryDependencies,
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
 * Registers a repository: validates it's a real Git repo, records
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

export async function findRepositoryByCanonicalPath(
  db: DrizzleDb,
  canonicalPath: string,
): Promise<Repository | undefined> {
  const rows = await db.select().from(repositories).where(eq(repositories.canonicalPath, canonicalPath));
  const row = rows[0];
  return row ? rowToRepository(row) : undefined;
}

/**
 * Unregisters a repository: removes its registry row and all discovery-derived rows (snapshots,
 * units, commands, services, QA surfaces). Does NOT touch the repository's files on disk — this
 * only detaches it from the workbench. Returns whether a row was removed.
 */
export async function unregisterRepository(db: DrizzleDb, repositoryId: string): Promise<boolean> {
  const existing = await getRepository(db, repositoryId);
  if (!existing) return false;

  // fact_sources references facts (not the repo directly), so clear it via the repo's fact ids first.
  const factIds = (
    await db.select({ id: repositoryFacts.id }).from(repositoryFacts).where(eq(repositoryFacts.repositoryId, repositoryId))
  ).map((r) => r.id);
  if (factIds.length > 0) {
    await db.delete(repositoryFactSources).where(inArray(repositoryFactSources.factId, factIds));
  }

  // Delete children before parents to respect FK constraints when enforcement is on.
  await db.delete(repositoryDependencies).where(eq(repositoryDependencies.repositoryId, repositoryId));
  await db.delete(repositorySymbols).where(eq(repositorySymbols.repositoryId, repositoryId));
  await db.delete(repositoryFacts).where(eq(repositoryFacts.repositoryId, repositoryId));
  await db.delete(repositoryQaSurfaces).where(eq(repositoryQaSurfaces.repositoryId, repositoryId));
  await db.delete(repositoryServices).where(eq(repositoryServices.repositoryId, repositoryId));
  await db.delete(repositoryCommands).where(eq(repositoryCommands.repositoryId, repositoryId));
  await db.delete(repositoryUnits).where(eq(repositoryUnits.repositoryId, repositoryId));
  await db.delete(repositorySnapshots).where(eq(repositorySnapshots.repositoryId, repositoryId));
  await db.delete(repositories).where(eq(repositories.id, repositoryId));
  return true;
}

export async function approveRepository(db: DrizzleDb, repositoryId: string): Promise<void> {
  await db
    .update(repositories)
    .set({ trusted: true, updatedAt: new Date().toISOString() })
    .where(eq(repositories.id, repositoryId));
}

/**
 * Runs full discovery for a repository and persists the resulting snapshot. Safe to call
 * repeatedly — each call inserts a new snapshot row rather than mutating a
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

  // Persist the discovery facts (previously computed on `snapshot.facts` then discarded — the missing
  // memory write). Refresh semantics: replace this repo's prior DISCOVERY facts (re-derived every
  // discovery), but PRESERVE compiled `concept` facts so accumulated synthesis survives a
  // re-scan. Facts remain traceable via their sourcePaths/sourceHashes provenance.
  await persistDiscoveryFacts(db, repository.id, snapshot.facts);

  await db
    .update(repositories)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(repositories.id, repository.id));

  return snapshot;
}

/**
 * Replaces a repository's discovery-derived facts with a fresh set, preserving compiled `concept`
 * facts. Writes the `repository_fact_sources` provenance join alongside each fact. Extracted so the
 * refresh path and tests share one implementation.
 */
export async function persistDiscoveryFacts(
  db: DrizzleDb,
  repositoryId: string,
  facts: RepositorySnapshot['facts'],
): Promise<void> {
  const stale = await db
    .select({ id: repositoryFacts.id, kind: repositoryFacts.kind })
    .from(repositoryFacts)
    .where(eq(repositoryFacts.repositoryId, repositoryId));
  const staleIds = stale.filter((r) => r.kind !== 'concept').map((r) => r.id);
  if (staleIds.length > 0) {
    await db.delete(repositoryFactSources).where(inArray(repositoryFactSources.factId, staleIds));
    await db.delete(repositoryFacts).where(inArray(repositoryFacts.id, staleIds));
  }

  for (const fact of facts) {
    await db.insert(repositoryFacts).values({
      id: fact.id,
      repositoryId,
      kind: fact.kind,
      statement: fact.statement,
      confidence: fact.confidence,
      observedAtSha: fact.observedAtSha,
      sourcePathsJson: JSON.stringify(fact.sourcePaths),
      sourceHashesJson: JSON.stringify(fact.sourceHashes),
      invalidatedByPathsJson: JSON.stringify(fact.invalidatedByPaths),
      supersededBy: fact.supersededBy ?? null,
    });
    if (fact.sourcePaths.length > 0) {
      await db.insert(repositoryFactSources).values(
        fact.sourcePaths.map((path, index) => ({
          factId: fact.id,
          path,
          sha256: fact.sourceHashes[index] ?? null,
        })),
      );
    }
  }
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
/**
 * Persists a `start` command that was resolved by inference/discovery over a task worktree and then
 * proven to boot (the browser-QA dev server became ready). Writing it back to the profile turns the
 * next exercise run into a Tier-1 persisted-command hit instead of re-inferring. Replaces any prior
 * `start` rows for the repo (the table has no unique constraint and reads take the first `start`
 * match), so a single validated row wins. Recorded as `source: 'inferred'`, `status: 'validated'`
 * with the candidate sha it was validated at.
 */
export async function persistValidatedStartCommand(
  db: DrizzleDb,
  repositoryId: string,
  input: { command: string; cwd: string; validatedAtSha?: string },
): Promise<void> {
  await db
    .delete(repositoryCommands)
    .where(and(eq(repositoryCommands.repositoryId, repositoryId), eq(repositoryCommands.purpose, 'start')));
  await db.insert(repositoryCommands).values({
    id: randomUUID(),
    repositoryId,
    unitId: null,
    purpose: 'start',
    command: input.command,
    cwd: input.cwd,
    source: 'inferred',
    status: 'validated',
    validatedAtSha: input.validatedAtSha ?? null,
    lastExitCode: 0,
  });
}

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
