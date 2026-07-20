export interface UploadToPullRequestInput {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  filePath: string;
  caption: string;
}

export interface UploadToPullRequestResult {
  commentId: string;
  attachmentUrl: string;
}

/**
 * GitHub's public API has no straightforward general binary-attachment endpoint for PR comments,
 * so video upload is isolated behind this interface (product spec §28) rather than folded into
 * the Octokit-backed GitHubClient. The MVP implementation drives a narrow Playwright browser
 * automation against the already-authenticated GitHub web UI — it is NOT used for any other
 * GitHub operation (push, PR create/update, comments all go through the real GitHub API/gh CLI).
 */
export interface GitHubMediaUploader {
  uploadToPullRequest(input: UploadToPullRequestInput): Promise<UploadToPullRequestResult>;
}
