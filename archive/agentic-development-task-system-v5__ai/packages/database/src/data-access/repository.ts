import { eq } from 'drizzle-orm';
import type { CommandPurpose, CommandSource, CommandStatus } from '@awb/domain';
import { repositoryCommands } from '../schema/index.js';
import type { DrizzleDb } from '../connection.js';

/** Read-model of a `repository_commands` row for the repo detail Commands & environment panel. */
export interface RepositoryCommandView {
  id: string;
  unitId: string | null;
  purpose: CommandPurpose;
  command: string;
  cwd: string;
  source: CommandSource;
  status: CommandStatus;
  validatedAtSha: string | null;
  lastExitCode: number | null;
}

/** Surfaces the existing `repository_commands` table for a repository (Commands & environment panel). */
export function getRepositoryCommands(db: DrizzleDb, repositoryId: string): RepositoryCommandView[] {
  return db
    .select({
      id: repositoryCommands.id,
      unitId: repositoryCommands.unitId,
      purpose: repositoryCommands.purpose,
      command: repositoryCommands.command,
      cwd: repositoryCommands.cwd,
      source: repositoryCommands.source,
      status: repositoryCommands.status,
      validatedAtSha: repositoryCommands.validatedAtSha,
      lastExitCode: repositoryCommands.lastExitCode,
    })
    .from(repositoryCommands)
    .where(eq(repositoryCommands.repositoryId, repositoryId))
    .all() as RepositoryCommandView[];
}
