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

/**
 * A narrow interface over exactly the GitHub operations this package needs, deliberately not the
 * full Octokit surface. Production code passes a real `@octokit/rest` instance wrapped to match
 * this shape (see `real-github-client.ts`); tests pass a fake implementing this same interface —
 * never a mocked Octokit, so tests are honest about which layer they're proving.
 */
export interface GitHubClient {
  createDraftPullRequest(input: CreateDraftPrInput): Promise<DraftPrRecord>;
  updatePullRequest(input: UpdatePrInput): Promise<void>;
  postComment(input: PostCommentInput): Promise<PostedComment>;
  getPrStatus(ref: RepoRef, pullNumber: number): Promise<PrStatus>;
  listPrComments(ref: RepoRef, pullNumber: number): Promise<RawPrComment[]>;
}
