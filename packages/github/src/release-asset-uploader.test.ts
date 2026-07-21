import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createReleaseAssetUploader } from './release-asset-uploader.js';

interface Calls {
  getByTag: number;
  createRelease: number;
  uploads: Array<{ release_id: number; name: string }>;
}

function fakeOctokit(calls: Calls, opts: { tagExists?: boolean } = {}): Octokit {
  return {
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
      async uploadReleaseAsset(args: { release_id: number; name: string }) {
        calls.uploads.push({ release_id: args.release_id, name: args.name });
        return { data: { browser_download_url: `https://github.com/dl/${args.name}` } };
      },
    },
  } as unknown as Octokit;
}

describe('createReleaseAssetUploader (Fix 7: QA media on the PR)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-media-'));
    filePath = join(dir, 'qa.webm');
    await writeFile(filePath, 'fake video bytes');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a release when none exists and returns the asset download URL', async () => {
    const calls: Calls = { getByTag: 0, createRelease: 0, uploads: [] };
    const uploader = createReleaseAssetUploader(fakeOctokit(calls));

    const result = await uploader.uploadToPullRequest({
      owner: 'o',
      repository: 'r',
      pullRequestNumber: 7,
      filePath,
      caption: 'qa-video',
    });

    expect(calls.createRelease).toBe(1);
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0]?.release_id).toBe(222);
    expect(result.attachmentUrl).toContain('https://github.com/dl/');
  });

  it('reuses one release for multiple artifacts on the same PR', async () => {
    const calls: Calls = { getByTag: 0, createRelease: 0, uploads: [] };
    const uploader = createReleaseAssetUploader(fakeOctokit(calls));

    await uploader.uploadToPullRequest({ owner: 'o', repository: 'r', pullRequestNumber: 7, filePath, caption: 'qa-video' });
    await uploader.uploadToPullRequest({ owner: 'o', repository: 'r', pullRequestNumber: 7, filePath, caption: 'browser-trace' });

    // Release created once (cached), asset uploaded twice.
    expect(calls.createRelease).toBe(1);
    expect(calls.uploads).toHaveLength(2);
  });

  it('reuses an existing release when the tag already exists', async () => {
    const calls: Calls = { getByTag: 0, createRelease: 0, uploads: [] };
    const uploader = createReleaseAssetUploader(fakeOctokit(calls, { tagExists: true }));

    const result = await uploader.uploadToPullRequest({ owner: 'o', repository: 'r', pullRequestNumber: 7, filePath, caption: 'qa-video' });

    expect(calls.createRelease).toBe(0);
    expect(calls.uploads[0]?.release_id).toBe(111);
    expect(result.commentId).toBe('111');
  });
});
