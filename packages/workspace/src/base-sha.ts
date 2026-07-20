import { runGit } from '@awb/repository';

/** Resolves a base ref (branch name, tag, or already-a-SHA) to a concrete, immutable SHA. */
export async function resolveBaseSha(repoPath: string, baseRef: string): Promise<string> {
  const { stdout } = await runGit(repoPath, ['rev-parse', baseRef]);
  return stdout;
}
