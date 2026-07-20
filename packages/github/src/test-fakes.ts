import type { GitHubClient } from './github-client.js';
import type { GitPushRunner } from './push.js';
import type {
  CreateDraftPrInput,
  DraftPrRecord,
  PostCommentInput,
  PostedComment,
  PrStatus,
  PushBranchInput,
  RawPrComment,
  RepoRef,
  UpdatePrInput,
} from './types.js';

/**
 * A fully in-memory fake GitHubClient — never touches the network. Used by every test in this
 * package; production code wires `createRealGitHubClient` (real-github-client.ts) instead. This
 * separation exists specifically so accidentally running this package's test suite can never
 * create a real PR or push a real branch, even though the developer's local `gh` CLI is
 * authenticated with broad repo/workflow scopes.
 */
export class FakeGitHubClient implements GitHubClient {
  createdPrs: CreateDraftPrInput[] = [];
  updatedPrs: UpdatePrInput[] = [];
  postedComments: PostCommentInput[] = [];
  private nextPrNumber = 1;
  private prStatuses = new Map<number, PrStatus>();
  private prComments = new Map<number, RawPrComment[]>();

  async createDraftPullRequest(input: CreateDraftPrInput): Promise<DraftPrRecord> {
    this.createdPrs.push(input);
    const number = this.nextPrNumber++;
    this.prStatuses.set(number, { state: 'open', headSha: 'fake-head-sha' });
    return {
      number,
      url: `https://github.com/${input.owner}/${input.repo}/pull/${number}`,
      headSha: 'fake-head-sha',
      nodeId: `fake-node-${number}`,
    };
  }

  async updatePullRequest(input: UpdatePrInput): Promise<void> {
    this.updatedPrs.push(input);
  }

  async postComment(input: PostCommentInput): Promise<PostedComment> {
    this.postedComments.push(input);
    const commentId = `comment-${this.postedComments.length}`;
    return { commentId, url: `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}#${commentId}` };
  }

  async getPrStatus(_ref: RepoRef, pullNumber: number): Promise<PrStatus> {
    return this.prStatuses.get(pullNumber) ?? { state: 'open', headSha: 'fake-head-sha' };
  }

  setPrStatus(pullNumber: number, status: PrStatus): void {
    this.prStatuses.set(pullNumber, status);
  }

  setPrComments(pullNumber: number, comments: RawPrComment[]): void {
    this.prComments.set(pullNumber, comments);
  }

  async listPrComments(_ref: RepoRef, pullNumber: number): Promise<RawPrComment[]> {
    return this.prComments.get(pullNumber) ?? [];
  }
}

/** A fully in-memory fake GitPushRunner — never shells out to real git push. */
export class FakeGitPushRunner implements GitPushRunner {
  pushes: PushBranchInput[] = [];
  shouldFail = false;

  async push(input: PushBranchInput): Promise<{ pushed: boolean }> {
    if (this.shouldFail) {
      throw new Error('simulated push failure');
    }
    this.pushes.push(input);
    return { pushed: true };
  }
}
