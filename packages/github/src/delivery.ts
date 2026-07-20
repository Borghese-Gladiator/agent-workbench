import type { Evidence } from '@awb/domain';
import type { GitHubClient } from './github-client.js';
import type { GitPushRunner } from './push.js';
import type { RepoRef, PushBranchInput, DraftPrRecord } from './types.js';
import { renderEvidenceMatrix } from './evidence-matrix.js';

export interface DeliverInput {
  ref: RepoRef;
  branchName: string;
  worktreePath: string;
  baseBranch: string;
  title: string;
  bodyIntro: string;
  candidateSha: string;
  evidence: Evidence[];
  /** Existing PR number if this is an update to an already-open draft PR, rather than a first delivery. */
  existingPrNumber?: number;
}

export interface DeliverResult {
  pushed: boolean;
  pr: DraftPrRecord | { number: number };
  evidenceMatrixCommentId: string;
}

/**
 * Deterministic GitHub delivery (product spec §28): push the branch, create-or-update the draft
 * PR, post the evidence matrix. Video upload is a separate step via GitHubMediaUploader, not
 * folded in here, since it uses a different (browser-automation) transport per spec §28. This
 * function performs no PR-feedback ingestion or merge-status polling — see feedback-classification.ts
 * and GitHubClient.getPrStatus for those, called separately by the caller (an Activity in
 * workers/temporal-worker) on its own polling cadence.
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

  let pr: DraftPrRecord | { number: number };
  if (input.existingPrNumber !== undefined) {
    await client.updatePullRequest({
      owner: input.ref.owner,
      repo: input.ref.repo,
      pullNumber: input.existingPrNumber,
      title: input.title,
      body: input.bodyIntro,
    });
    pr = { number: input.existingPrNumber };
  } else {
    pr = await client.createDraftPullRequest({
      owner: input.ref.owner,
      repo: input.ref.repo,
      headBranch: input.branchName,
      baseBranch: input.baseBranch,
      title: input.title,
      body: input.bodyIntro,
    });
  }

  const evidenceMatrix = renderEvidenceMatrix(input.evidence, input.candidateSha);
  const comment = await client.postComment({
    owner: input.ref.owner,
    repo: input.ref.repo,
    pullNumber: pr.number,
    body: evidenceMatrix,
  });

  return { pushed, pr, evidenceMatrixCommentId: comment.commentId };
}
