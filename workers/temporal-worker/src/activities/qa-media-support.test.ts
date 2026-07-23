import { describe, expect, it } from 'vitest';
import type { GitHubMediaUploader, UploadToPullRequestResult } from '@awb/github';
import type { ArtifactRecord } from '@awb/domain';
import { postQaMediaBriefs, type QaMediaFile } from './qa-media-support.js';

// postQaMediaBriefs only reads record.kind + path, so the fixture is minimal by design.
function mediaFile(kind: ArtifactRecord['kind'], path = '/store/sha256/ab/abc123'): QaMediaFile {
  return { path, record: { kind } as ArtifactRecord };
}

/** A GitHubClient stub that records posted comments. */
function fakeClient() {
  const comments: string[] = [];
  return {
    comments,
    async postComment(input: { body: string }) {
      comments.push(input.body);
      return { commentId: `c${comments.length}`, url: `https://example.com/c/${comments.length}` };
    },
  };
}

/** An uploader stub with a scriptable outcome per call. */
function fakeUploader(outcome: (call: number) => UploadToPullRequestResult | 'throw'): GitHubMediaUploader {
  let call = 0;
  return {
    async uploadToPullRequest(): Promise<UploadToPullRequestResult> {
      const result = outcome(call++);
      if (result === 'throw') throw new Error('simulated upload failure');
      return result;
    },
  };
}

const base = { owner: 'o', repo: 'r', pullRequestNumber: 2, qaSummary: 'Browser QA: 2/2 assertions passed' };

describe('postQaMediaBriefs', () => {
  // This is the regression that produced "QA artifact (qa-video): undefined" on PR #2:
  // the real uploader returned browser_download_url === undefined WITHOUT throwing.
  it('treats an undefined attachmentUrl as a failed upload and posts NO comment', async () => {
    const client = fakeClient();
    const uploader = fakeUploader(() => ({ commentId: 'x', attachmentUrl: undefined as unknown as string }));

    const result = await postQaMediaBriefs({
      ...base,
      mediaFiles: [mediaFile('qa-video'), mediaFile('browser-trace')],
      uploader,
      client,
    });

    expect(result.requiredVideosUploaded).toBe(false);
    expect(result.postedCount).toBe(0);
    expect(client.comments).toHaveLength(0);
    // Crucially: nothing containing "undefined" was ever posted.
    expect(client.comments.join('')).not.toContain('undefined');
  });

  it('posts a descriptive brief (not "QA artifact: url") when the upload yields a real URL', async () => {
    const client = fakeClient();
    const uploader = fakeUploader(() => ({
      commentId: 'x',
      attachmentUrl: 'https://github.com/o/r/releases/download/awb-qa-2/2-video.webm',
    }));

    const result = await postQaMediaBriefs({ ...base, mediaFiles: [mediaFile('qa-video')], uploader, client });

    expect(result.requiredVideosUploaded).toBe(true);
    expect(result.postedCount).toBe(1);
    expect(client.comments[0]).toContain('Browser QA recording');
    expect(client.comments[0]).toContain('releases/download/awb-qa-2/2-video.webm');
    expect(client.comments[0]).not.toContain('QA artifact');
    expect(client.comments[0]).not.toContain('undefined');
  });

  it('treats a thrown upload as a failed upload without posting', async () => {
    const client = fakeClient();
    const uploader = fakeUploader(() => 'throw');

    const result = await postQaMediaBriefs({ ...base, mediaFiles: [mediaFile('qa-video')], uploader, client });

    expect(result.requiredVideosUploaded).toBe(false);
    expect(client.comments).toHaveLength(0);
  });

  it('is vacuously satisfied when there is no media to upload', async () => {
    const client = fakeClient();
    const uploader = fakeUploader(() => ({ commentId: 'x', attachmentUrl: 'u' }));

    const result = await postQaMediaBriefs({ ...base, mediaFiles: [], uploader, client });

    expect(result.requiredVideosUploaded).toBe(true);
    expect(result.postedCount).toBe(0);
  });

  it('posts the good one and flags failure when uploads are mixed', async () => {
    const client = fakeClient();
    // First upload succeeds, second returns undefined URL.
    const uploader = fakeUploader((call) =>
      call === 0
        ? { commentId: 'x', attachmentUrl: 'https://example.com/dl/video.webm' }
        : { commentId: 'y', attachmentUrl: undefined as unknown as string },
    );

    const result = await postQaMediaBriefs({
      ...base,
      mediaFiles: [mediaFile('qa-video'), mediaFile('browser-trace')],
      uploader,
      client,
    });

    expect(result.postedCount).toBe(1);
    expect(result.requiredVideosUploaded).toBe(false);
    expect(client.comments).toHaveLength(1);
    expect(client.comments.join('')).not.toContain('undefined');
  });
});
