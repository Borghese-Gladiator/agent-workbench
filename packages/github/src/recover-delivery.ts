import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/rest';
import { getRemotes } from '@awb/repository';
import type { Evidence } from '@awb/domain';
import { createRealGitHubClient } from './real-github-client.js';
import { realGitPushRunner } from './push.js';
import { deliverToGitHub } from './delivery.js';
import type { RepoRef } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Recover-and-land delivery (TASK-113/114). When a task's implement phase completed and committed
 * to its worktree branch but the run never reached the normal `release` phase — verify hung or was
 * killed (resource exhaustion / a self-booting e2e test / a torn-down stack) — the deliverable is
 * already on disk and should still become a draft PR. This module opens (or updates) that draft PR
 * straight from the committed worktree branch, honestly labeling that verification did not run.
 *
 * It is the programmatic form of the hand-run rescue (`git push` + `gh pr create --draft`) that was
 * needed for 8 of 10 tasks in the batch that surfaced these gaps. Reuses the same `deliverToGitHub`
 * primitive as the normal release path; performs NO merge and never marks the PR ready.
 */

function parseGitHubRemote(url: string): RepoRef | undefined {
  const cleaned = url.replace(/\.git$/, '');
  const match = /github\.com[/:]([^/]+)\/(.+)$/.exec(cleaned);
  if (!match) return undefined;
  return { owner: match[1] as string, repo: match[2] as string };
}

/** Resolves the GitHub owner/repo for a worktree from its `origin` remote (fetch URL). */
export async function resolveRepoRef(worktreePath: string): Promise<RepoRef | undefined> {
  const remotes = await getRemotes(worktreePath);
  const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  if (!origin) return undefined;
  return parseGitHubRemote(origin.fetchUrl || origin.pushUrl);
}

/** The token the real GitHub client authenticates with, taken from the ambient `gh` CLI login. */
async function resolveGitHubToken(): Promise<string> {
  const { stdout } = await execFileAsync('gh', ['auth', 'token']);
  return stdout.trim();
}

export interface RecoverDeliverInput {
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  candidateSha: string;
  objective: string;
  changedPaths: string[];
  evidence: Evidence[];
  /** Why the normal release path was bypassed — surfaced in the PR body so a reviewer knows. */
  unmetReason: string;
  existingPrNumber?: number;
}

export interface RecoverDeliverResult {
  prNumber: number;
  prUrl?: string;
  title: string;
  ref: RepoRef;
}

/**
 * Pushes the committed worktree branch and opens/updates a DRAFT PR from it, with an honest
 * verification-not-run note folded into the objective. Throws if the worktree has no
 * GitHub-parseable `origin` (a no-remote repo lands locally via a different path, not here).
 */
export async function recoverAndDeliverDraft(
  input: RecoverDeliverInput,
): Promise<RecoverDeliverResult> {
  const ref = await resolveRepoRef(input.worktreePath);
  if (!ref) {
    throw new Error(
      `recover-and-land: worktree ${input.worktreePath} has no GitHub-parseable 'origin' remote — ` +
        `deliver locally instead (no PR to open).`,
    );
  }
  const token = await resolveGitHubToken();
  const octokit = new Octokit({ auth: token });
  const client = createRealGitHubClient(octokit);

  const result = await deliverToGitHub(
    {
      ref,
      branchName: input.branchName,
      worktreePath: input.worktreePath,
      baseBranch: input.baseBranch,
      objective: `${input.objective}\n\n> ⚠️ Recovered draft PR — ${input.unmetReason}. The workbench did NOT complete verification for this change; review the diff before merging.`,
      changedPaths: input.changedPaths,
      candidateSha: input.candidateSha,
      evidence: input.evidence,
      existingPrNumber: input.existingPrNumber,
    },
    client,
    realGitPushRunner,
  );

  const prNumber = result.pr.number;
  const prUrl = 'url' in result.pr ? result.pr.url : undefined;
  return { prNumber, prUrl, title: result.title, ref };
}
