export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PushBranchInput extends RepoRef {
  branchName: string;
  worktreePath: string;
  force?: boolean;
}

export interface CreateDraftPrInput extends RepoRef {
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface DraftPrRecord {
  number: number;
  url: string;
  headSha: string;
  nodeId: string;
}

export interface UpdatePrInput extends RepoRef {
  pullNumber: number;
  body?: string;
  title?: string;
}

export interface PostCommentInput extends RepoRef {
  pullNumber: number;
  body: string;
}

export interface PostedComment {
  commentId: string;
  url: string;
}

export type PrMergeState = 'open' | 'merged' | 'closed';

export interface PrStatus {
  state: PrMergeState;
  mergeCommitSha?: string;
  headSha: string;
}

export interface RawPrComment {
  commentId: string;
  author: string;
  body: string;
  createdAt: string;
  isReview: boolean;
}
