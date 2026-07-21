import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { GitHubMediaUploader, UploadToPullRequestInput, UploadToPullRequestResult } from './media-uploader.js';

/**
 * A GitHubMediaUploader backed by the public Releases REST API (Octokit, authed by the same token
 * as the rest of delivery). GitHub's inline PR-comment attachment endpoint
 * (github.com/upload/policies/assets) is browser-session-only and not part of the public API, so we
 * host QA media as a release asset instead and surface its stable download URL — reachable with a
 * plain token, unlike the web-UI paste flow.
 *
 * All artifacts for a task share one release, tagged `awb-qa-<pullRequestNumber>`, created lazily on
 * first upload and reused thereafter.
 */
export function createReleaseAssetUploader(octokit: Octokit): GitHubMediaUploader {
  const releaseIdByTag = new Map<string, { releaseId: number; uploadUrl: string }>();

  async function ensureRelease(owner: string, repo: string, prNumber: number): Promise<{ releaseId: number; uploadUrl: string }> {
    const tag = `awb-qa-${prNumber}`;
    const cached = releaseIdByTag.get(`${owner}/${repo}/${tag}`);
    if (cached) return cached;

    // Reuse an existing release for this tag if a prior attempt created one, else make it.
    try {
      const existing = await octokit.repos.getReleaseByTag({ owner, repo, tag });
      const entry = { releaseId: existing.data.id, uploadUrl: existing.data.upload_url };
      releaseIdByTag.set(`${owner}/${repo}/${tag}`, entry);
      return entry;
    } catch {
      const created = await octokit.repos.createRelease({
        owner,
        repo,
        tag_name: tag,
        name: `AWB QA artifacts for PR #${prNumber}`,
        body: `QA evidence (video/trace) uploaded by the Agentic Workbench for PR #${prNumber}.`,
        draft: false,
        prerelease: true,
      });
      const entry = { releaseId: created.data.id, uploadUrl: created.data.upload_url };
      releaseIdByTag.set(`${owner}/${repo}/${tag}`, entry);
      return entry;
    }
  }

  return {
    async uploadToPullRequest(input: UploadToPullRequestInput): Promise<UploadToPullRequestResult> {
      const { releaseId } = await ensureRelease(input.owner, input.repository, input.pullRequestNumber);
      const data = await readFile(input.filePath);
      const name = `${input.pullRequestNumber}-${basename(input.filePath)}`;

      const uploaded = await octokit.repos.uploadReleaseAsset({
        owner: input.owner,
        repo: input.repository,
        release_id: releaseId,
        name,
        // Octokit accepts a Buffer/string body for binary asset upload.
        data: data as unknown as string,
      });

      return {
        commentId: String(releaseId),
        attachmentUrl: uploaded.data.browser_download_url,
      };
    },
  };
}
