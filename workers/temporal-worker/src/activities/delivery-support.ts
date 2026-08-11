import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/rest';
import { getRemotes, getDefaultBranch } from '@awb/repository';
import {
  createRealGitHubClient,
  createReleaseAssetUploader,
  realGitPushRunner,
  type GitHubClient,
  type GitHubMediaUploader,
  type GitPushRunner,
  type RepoRef,
} from '@awb/github';

const execFileAsync = promisify(execFile);

/**
 * Parses `owner/repo` from a GitHub remote URL (https or ssh form), stripping a trailing `.git`.
 * Returns undefined for a non-GitHub remote.
 */
export function parseGitHubRemote(url: string): RepoRef | undefined {
  const cleaned = url.replace(/\.git$/, '');
  const https = /github\.com[/:]([^/]+)\/(.+)$/.exec(cleaned);
  if (!https) return undefined;
  return { owner: https[1] as string, repo: https[2] as string };
}

/** Resolves the GitHub owner/repo for a worktree from its `origin` remote (fetch URL). */
export async function resolveRepoRef(worktreePath: string): Promise<RepoRef | undefined> {
  const remotes = await getRemotes(worktreePath);
  const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  if (!origin) return undefined;
  return parseGitHubRemote(origin.fetchUrl || origin.pushUrl);
}

/**
 * Resolves the repository root (main checkout) that owns a linked worktree, so a local merge can
 * check out and merge into the default branch there. `--git-common-dir` points at the shared
 * `<repo>/.git`; its parent is the repo root. Falls back to the worktree itself if the repo is not
 * a linked worktree (the common dir already sits at the worktree root).
 */
export async function resolveRepositoryRoot(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: worktreePath,
  });
  const commonDir = stdout.trim();
  return commonDir.endsWith('/.git') ? commonDir.slice(0, -'/.git'.length) : worktreePath;
}

/**
 * Decides where a finished branch should land. When the worktree has a GitHub-parseable `origin`,
 * delivery opens a real draft PR (`kind: 'github'`). When there is NO such remote, delivery falls
 * back to a local merge into the repo's default branch (`kind: 'local-merge'`) — the no-remote
 * mirror of `close-worktree`'s cleanup path, so a done change still lands instead of stranding.
 */
export async function resolveDeliveryTarget(
  worktreePath: string,
): Promise<{ kind: 'github'; ref: RepoRef } | { kind: 'local-merge'; defaultBranch: string }> {
  const ref = await resolveRepoRef(worktreePath);
  if (ref) return { kind: 'github', ref };
  const defaultBranch = await getDefaultBranch(worktreePath);
  return { kind: 'local-merge', defaultBranch };
}

/** The token the real GitHub client authenticates with, taken from the ambient `gh` CLI login. */
export async function resolveGitHubToken(): Promise<string> {
  const { stdout } = await execFileAsync('gh', ['auth', 'token']);
  return stdout.trim();
}

/**
 * Builds the real (Octokit-backed) GitHub client + git-CLI push runner + release-asset media
 * uploader for the release phase (Fix 6 client/push, Fix 7 uploader). All three share one Octokit
 * instance authed by the ambient `gh` token.
 */
export async function createRealDelivery(): Promise<{
  client: GitHubClient;
  pushRunner: GitPushRunner;
  mediaUploader: GitHubMediaUploader;
}> {
  const token = await resolveGitHubToken();
  const octokit = new Octokit({ auth: token });
  return {
    client: createRealGitHubClient(octokit),
    pushRunner: realGitPushRunner,
    mediaUploader: createReleaseAssetUploader(octokit),
  };
}
