import type { Evidence } from '@awb/domain';
import type { GitHubClient } from './github-client.js';
import type { GitPushRunner } from './push.js';
import type { RepoRef, PushBranchInput, DraftPrRecord } from './types.js';
import { derivePrTitle, renderPrBody } from './pr-content.js';

export interface DeliverInput {
  ref: RepoRef;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
  /** The task objective (the human's request) — the source for the short title + Background. */
  objective: string;
  /** The planner's one-line summary, used in the Changes section. */
  planSummary?: string;
  /** Repo-relative paths the candidate diff touched, listed in the Changes section. */
  changedPaths: string[];
  candidateSha: string;
  evidence: Evidence[];
  /** Existing PR number if this is an update to an already-open draft PR, rather than a first delivery. */
  existingPrNumber?: number;
}

export interface DeliverResult {
  pushed: boolean;
  pr: DraftPrRecord | { number: number };
  /** The short, brief title actually used for the PR (no `[AWB]` prefix). */
  title: string;
}

/**
 * Deterministic GitHub delivery (product spec §28): push the branch, create-or-update the draft
 * PR with a SHORT brief title + a templated body (Background / Changes / Test plan). The evidence
 * is folded into the PR body's Test plan section — we no longer post a separate, non-actionable
 * "evidence matrix" comment. QA-media briefs are a separate step via GitHubMediaUploader in the
 * caller. This function performs no PR-feedback ingestion or merge-status polling.
 */
export async function deliverToGitHub(
  input: DeliverInput,
  client: GitHubClient,
  pushRunner: GitPushRunner,
): Promise<DeliverResult> {
  const pushInput: PushBranchInput = {
    owner: input.ref.owner,
    repo: input.ref.repo,
    branchName: input.branchName,
    worktreePath: input.worktreePath,
    force: input.existingPrNumber !== undefined,
  };
  const { pushed } = await pushRunner.push(pushInput);

  const title = derivePrTitle(input.objective, input.changedPaths);
  const body = renderPrBody({
    objective: input.objective,
    planSummary: input.planSummary,
    changedPaths: input.changedPaths,
    evidence: input.evidence,
    candidateSha: input.candidateSha,
  });

  let pr: DraftPrRecord | { number: number };
  if (input.existingPrNumber !== undefined) {
    await client.updatePullRequest({
      owner: input.ref.owner,
      repo: input.ref.repo,
      pullNumber: input.existingPrNumber,
      title,
      body,
    });
    pr = { number: input.existingPrNumber };
  } else {
    pr = await client.createDraftPullRequest({
      owner: input.ref.owner,
      repo: input.ref.repo,
      headBranch: input.branchName,
      baseBranch: input.baseBranch,
      title,
      body,
    });
  }

  return { pushed, pr, title };
}
