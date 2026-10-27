import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createReleaseAssetUploader } from './release-asset-uploader.js';

interface Calls {
  getByTag: number;
  createRelease: number;
  uploads: Array<{ url: string; name: string; contentType?: string }>;
  deletedAssetIds: number[];
}

function fakeOctokit(
  calls: Calls,
  opts: { tagExists?: boolean; noDownloadUrl?: boolean; existingAssets?: { id: number; name: string }[] } = {},
): Octokit {
  return {
    // The uploader posts the asset to the release's own upload_url via octokit.request (NOT
    // repos.uploadReleaseAsset, whose api.github.com route 307-redirects for renamed repos and drops
    // the body). Intercept request() so the tests exercise that real path.
    async request(args: { url: string; name: string; headers?: { 'content-type'?: string } }) {
      calls.uploads.push({ url: args.url, name: args.name, contentType: args.headers?.['content-type'] });
      if (opts.noDownloadUrl) {
        // GitHub can silently accept the call and store nothing (observed on PR #2 / the 307 case).
        return { data: { browser_download_url: undefined } };
      }
      return { data: { browser_download_url: `https://github.com/dl/${args.name}` } };
    },
    repos: {
      async getReleaseByTag() {
        calls.getByTag += 1;
        if (opts.tagExists) {
          return { data: { id: 111, upload_url: 'https://uploads/111' } };
        }
        throw new Error('not found');
      },
      async createRelease() {
        calls.createRelease += 1;
        return { data: { id: 222, upload_url: 'https://uploads/222' } };
      },
      async listReleaseAssets() {
        return { data: opts.existingAssets ?? [] };
      },
      async deleteReleaseAsset(args: { asset_id: number }) {
        calls.deletedAssetIds.push(args.asset_id);
        return { data: {} };
      },
    },
  } as unknown as Octokit;
}

describe('createReleaseAssetUploader (Fix 7: QA media on the PR)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-media-'));
    // The ArtifactStore hands us a content-hash blob path with NO extension (the PR #2 regression).
    filePath = join(dir, '76e64273c949');
    await writeFile(filePath, 'fake video bytes');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a release when none exists and returns the asset download URL', async () => {
    const calls: Calls = { getByTag: 0, createRelease: 0, uploads: [], deletedAssetIds: [] };
    const uploader = createReleaseAssetUploader(fakeOctokit(calls));

    const result = await uploader.uploadToPullRequest({
      owner: 'o',
      repository: 'r',
      pullRequestNumber: 7,
      filePath,
      caption: 'qa-video',
      mediaType: 'video/webm',
    });

    expect(calls.createRelease).toBe(1);
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0]?.url).toBe('https://uploads/222');
    expect(result.attachmentUrl).toContain('https://github.com/dl/');
  });

  it('gives the extensionless blob a real filename + content-type from mediaType', async () => {
    const calls: Calls = { getByTag: 0, createRelease: 0, uploads: [], deletedAssetIds: [] };
    const uploader = createReleaseAssetUploader(fakeOctokit(calls));

    await uploader.uploadToPullRequest({
      owner: 'o',
      repository: 'r',
      pullRequestNumber: 7,
      filePath,
      caption: 'browser-trace',
      mediaType: 'application/zip',
    });

    expect(calls.uploads[0]?.name).toBe('7-76e64273c949.zip');
    expect(calls.uploads[0]?.contentType).toBe('application/zip');
  });

  it('throws when GitHub accepts the upload but returns no download URL', async () => {
    const calls: Calls = { getByTag: 0, createRelease: 0, uploads: [], deletedAssetIds: [] };
    const uploader = createReleaseAssetUploader(fakeOctokit(calls, { noDownloadUrl: true }));

    await expect(
      uploader.uploadToPullRequest({
        owner: 'o',
        repository: 'r',
        pullRequestNumber: 7,
        filePath,
        caption: 'qa-video',
        mediaType: 'video/webm',
      }),
    ).rejects.toThrow(/no download URL/);
    // The asset call was still attempted (so the failure is the missing URL, not a skipped upload).
    expect(calls.uploads).toHaveLength(1);
  });

  it('reuses one release for multiple artifacts on the same PR', async () => {
    const calls: Calls = { getByTag: 0, createRelease: 0, uploads: [], deletedAssetIds: [] };
    const uploader = createReleaseAssetUploader(fakeOctokit(calls));

    await uploader.uploadToPullRequest({ owner: 'o', repository: 'r', pullRequestNumber: 7, filePath, caption: 'qa-video' });
    await uploader.uploadToPullRequest({ owner: 'o', repository: 'r', pullRequestNumber: 7, filePath, caption: 'browser-trace' });

    // Release created once (cached), asset uploaded twice.
    expect(calls.createRelease).toBe(1);
    expect(calls.uploads).toHaveLength(2);
  });

  it('reuses an existing release when the tag already exists', async () => {
    const calls: Calls = { getByTag: 0, createRelease: 0, uploads: [], deletedAssetIds: [] };
    const uploader = createReleaseAssetUploader(fakeOctokit(calls, { tagExists: true }));

    const result = await uploader.uploadToPullRequest({ owner: 'o', repository: 'r', pullRequestNumber: 7, filePath, caption: 'qa-video' });

    expect(calls.createRelease).toBe(0);
    expect(calls.uploads[0]?.url).toBe('https://uploads/111');
    expect(result.commentId).toBe('111');
  });

  // On a retry (Temporal re-runs the Activity, or the release is reused across attempts) an asset
  // with the same name already exists. GitHub then returns no download URL for the re-upload — the
  // failure that blocked release live. The uploader must delete the stale same-named asset first.
  it('deletes a pre-existing same-named asset before re-uploading (idempotent retry)', async () => {
    const calls: Calls = { getByTag: 0, createRelease: 0, uploads: [], deletedAssetIds: [] };
    const uploader = createReleaseAssetUploader(
      fakeOctokit(calls, {
        tagExists: true,
        existingAssets: [
          { id: 999, name: '7-76e64273c949.zip' }, // same name we're about to upload
          { id: 1000, name: 'unrelated.png' },
        ],
      }),
    );

    const result = await uploader.uploadToPullRequest({
      owner: 'o',
      repository: 'r',
      pullRequestNumber: 7,
      filePath,
      caption: 'browser-trace',
      mediaType: 'application/zip',
    });

    // Only the colliding asset is deleted; the unrelated one is left alone.
    expect(calls.deletedAssetIds).toEqual([999]);
    expect(result.attachmentUrl).toContain('https://github.com/dl/7-76e64273c949.zip');
  });
});
