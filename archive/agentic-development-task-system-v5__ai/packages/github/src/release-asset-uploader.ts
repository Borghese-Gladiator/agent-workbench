import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Octokit } from '@octokit/rest';
import type { GitHubMediaUploader, UploadToPullRequestInput, UploadToPullRequestResult } from './media-uploader.js';
import { CLAUDE_CODE_SIGNATURE } from './pr-content.js';

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
const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  'video/webm': '.webm',
  'application/zip': '.zip',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'text/plain': '.txt',
  'application/json': '.json',
  'application/x-ndjson': '.ndjson',
};

function assetName(prNumber: number, filePath: string, mediaType?: string): string {
  const base = basename(filePath);
  // The ArtifactStore blob path has no extension. GitHub rejects an extensionless asset, so append
  // the extension implied by the mediaType when the base name doesn't already carry one.
  const hasExtension = /\.[a-z0-9]+$/i.test(base);
  const ext = mediaType ? EXTENSION_BY_MEDIA_TYPE[mediaType] : undefined;
  const name = hasExtension || !ext ? base : `${base}${ext}`;
  return `${prNumber}-${name}`;
}

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
        body: `${CLAUDE_CODE_SIGNATURE}\n\nQA evidence (video/trace) uploaded by the Agentic Workbench for PR #${prNumber}.`,
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
      const { releaseId, uploadUrl } = await ensureRelease(input.owner, input.repository, input.pullRequestNumber);
      const data = await readFile(input.filePath);
      const name = assetName(input.pullRequestNumber, input.filePath, input.mediaType);

      // Idempotency: a release can be reused across attempts (the tag is per-PR, not per-attempt),
      // and this Activity can be re-run by Temporal after a partial success. GitHub rejects a SECOND
      // upload of an already-present asset name by returning no download URL (no throw) — the exact
      // "asset was not stored" failure that blocked release on a retry. Delete any prior asset with
      // this name first so the re-upload lands cleanly.
      try {
        const existing = await octokit.repos.listReleaseAssets({
          owner: input.owner,
          repo: input.repository,
          release_id: releaseId,
          per_page: 100,
        });
        for (const asset of existing.data) {
          if (asset.name === name) {
            await octokit.repos.deleteReleaseAsset({
              owner: input.owner,
              repo: input.repository,
              asset_id: asset.id,
            });
          }
        }
      } catch {
        // A listing/delete failure shouldn't abort the upload; fall through and let the POST decide.
      }

      // Post to the release's own `upload_url` (on uploads.github.com), not
      // `repos.uploadReleaseAsset({owner,repo,release_id})`. The convenience method routes through
      // api.github.com, which 307-redirects when the repo has been renamed on GitHub (observed on
      // wip-browser-games → browser-games__ai); Octokit follows the redirect but does not re-send the
      // body, so GitHub accepts nothing and returns an undefined download URL. The release's
      // upload_url already carries the canonical repo, so it lands directly with a 201.
      const uploaded = await octokit.request({
        method: 'POST',
        url: uploadUrl,
        name,
        headers: {
          'content-length': data.length,
          ...(input.mediaType ? { 'content-type': input.mediaType } : {}),
        },
        // Octokit accepts a Buffer body for binary asset upload.
        data: data as unknown as string,
      });

      const attachmentUrl = uploaded.data.browser_download_url as string | undefined;
      if (!attachmentUrl) {
        // GitHub can silently accept the call and attach nothing (observed on PR #2: release created,
        // 0 assets, undefined download URL, no throw). Surface it as an error so callers don't post a
        // broken `undefined` link.
        throw new Error(
          `GitHub accepted the release-asset upload for "${name}" but returned no download URL (asset was not stored).`,
        );
      }

      return {
        commentId: String(releaseId),
        attachmentUrl,
      };
    },
  };
}
