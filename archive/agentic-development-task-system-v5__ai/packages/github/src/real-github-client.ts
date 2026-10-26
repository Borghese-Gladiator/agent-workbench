import { Octokit } from '@octokit/rest';
import type { GitHubClient } from './github-client.js';
import type {
  CreateDraftPrInput,
  DraftPrRecord,
  PostCommentInput,
  PostedComment,
  PrStatus,
  RawPrComment,
  RepoRef,
  UpdatePrInput,
} from './types.js';

/** Wraps a real @octokit/rest instance to the narrow GitHubClient interface this package depends on. */
export function createRealGitHubClient(octokit: Octokit): GitHubClient {
  return {
    async createDraftPullRequest(input: CreateDraftPrInput): Promise<DraftPrRecord> {
      const { data } = await octokit.pulls.create({
        owner: input.owner,
        repo: input.repo,
        head: input.headBranch,
        base: input.baseBranch,
        title: input.title,
        body: input.body,
        draft: true,
      });
      return {
        number: data.number,
        url: data.html_url,
        headSha: data.head.sha,
        nodeId: data.node_id,
      };
    },

    async updatePullRequest(input: UpdatePrInput): Promise<void> {
      await octokit.pulls.update({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        title: input.title,
        body: input.body,
      });
    },

    async postComment(input: PostCommentInput): Promise<PostedComment> {
      const { data } = await octokit.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.pullNumber,
        body: input.body,
      });
      return { commentId: String(data.id), url: data.html_url };
    },

    async getPrStatus(ref: RepoRef, pullNumber: number): Promise<PrStatus> {
      const { data } = await octokit.pulls.get({ owner: ref.owner, repo: ref.repo, pull_number: pullNumber });
      const state: PrStatus['state'] = data.merged ? 'merged' : data.state === 'closed' ? 'closed' : 'open';
      return {
        state,
        mergeCommitSha: data.merge_commit_sha ?? undefined,
        headSha: data.head.sha,
      };
    },

    async listPrComments(ref: RepoRef, pullNumber: number): Promise<RawPrComment[]> {
      const [issueComments, reviewComments] = await Promise.all([
        octokit.issues.listComments({ owner: ref.owner, repo: ref.repo, issue_number: pullNumber }),
        octokit.pulls.listReviewComments({ owner: ref.owner, repo: ref.repo, pull_number: pullNumber }),
      ]);
      const fromIssues: RawPrComment[] = issueComments.data.map((c) => ({
        commentId: String(c.id),
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.created_at,
        isReview: false,
      }));
      const fromReviews: RawPrComment[] = reviewComments.data.map((c) => ({
        commentId: String(c.id),
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.created_at,
        isReview: true,
      }));
      return [...fromIssues, ...fromReviews];
    },
  };
}
