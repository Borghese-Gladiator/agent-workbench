import { createDatabase } from '@awb/database';
import { initDataDir } from '@awb/config';
import { getRepositoryCommands, runGit, getChangedPaths } from '@awb/repository';
import type { ValidatedCommand, CommandPurpose } from '@awb/domain';

/**
 * Resolves the repository's real discovered verification commands (Fix 2), replacing the hardcoded
 * `echo ok`. Returns the `unit-test` and `build` commands from the latest snapshot, cwd-rebased to
 * the task worktree so they run against the candidate diff. Returns [] when discovery found none
 * (the caller then keeps its placeholder / treats it as nothing-to-verify).
 */
export async function resolveVerificationCommands(input: {
  repositoryId: string;
  worktreePath: string;
}): Promise<ValidatedCommand[]> {
  const { layout } = initDataDir();
  const database = createDatabase(layout.workbenchSqlite);
  try {
    const all = await getRepositoryCommands(database.db, input.repositoryId);
    const verifyPurposes: CommandPurpose[] = ['unit-test', 'build'];
    return all
      .filter((c) => verifyPurposes.includes(c.purpose))
      .map((c) => ({ ...c, cwd: input.worktreePath }));
  } finally {
    database.close();
  }
}

/**
 * Resolves the repository's discovered dev-server start command (purpose `start`), if any, for the
 * browser-QA path (Fix 5). Returns the command string cwd-rebased implicitly via the caller's
 * worktree, or undefined when the repo has no discovered start command.
 */
export async function resolveStartCommand(repositoryId: string): Promise<string | undefined> {
  const { layout } = initDataDir();
  const database = createDatabase(layout.workbenchSqlite);
  try {
    const all = await getRepositoryCommands(database.db, repositoryId);
    return all.find((c) => c.purpose === 'start')?.command;
  } finally {
    database.close();
  }
}

/**
 * Computes the real candidate diff + changed paths from the worktree (Fix 4), replacing the
 * hardcoded placeholder diff string handed to the adversarial reviewer. Uses `baseSha..candidateSha`
 * so the reviewer sees exactly what the builder produced. Returns an empty diff on any git error
 * (e.g. no real commit yet), so the reviewer still runs rather than the phase crashing.
 */
export async function resolveReviewDiff(input: {
  worktreePath: string;
  baseSha: string;
  candidateSha: string;
}): Promise<{ diff: string; changedPaths: string[] }> {
  try {
    const { stdout } = await runGit(input.worktreePath, ['diff', `${input.baseSha}..${input.candidateSha}`]);
    const changedPaths = await getChangedPaths(input.worktreePath, input.baseSha, input.candidateSha);
    return { diff: stdout, changedPaths };
  } catch {
    return { diff: '', changedPaths: [] };
  }
}
