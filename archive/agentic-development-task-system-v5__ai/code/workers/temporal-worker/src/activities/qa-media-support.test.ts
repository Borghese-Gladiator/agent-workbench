import { describe, expect, it } from 'vitest';
import type { GitHubMediaUploader, UploadToPullRequestResult } from '@awb/github';
import type { ArtifactRecord } from '@awb/domain';
import { postQaMediaBriefs, qaMediaFileName, type QaMediaFile } from './qa-media-support.js';

function traceFile(path = '/store/sha256/ab/abc123'): QaMediaFile {
  return { path, record: { kind: 'browser-trace', mediaType: 'application/zip' } as ArtifactRecord };
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

const base = {
  owner: 'o',
  repo: 'r',
  pullRequestNumber: 2,
  branch: 'awb/feature',
  qaSummary: 'Browser QA: 2/2 assertions passed',
};

describe('postQaMediaBriefs', () => {
  it('posts ONE consolidated comment with in-tab links for committed screenshot + video', async () => {
    const client = fakeClient();
    const uploader = fakeUploader(() => ({ commentId: 'x', attachmentUrl: 'unused' }));

    const result = await postQaMediaBriefs({
      ...base,
      committedMedia: [
        { kind: 'screenshot', repoPath: '.awb/qa/screenshot.png' },
        { kind: 'qa-video', repoPath: '.awb/qa/recording.webm' },
      ],
      traceFiles: [],
      uploader,
      client,
    });

    expect(result.requiredVideosUploaded).toBe(true);
    expect(result.postedCount).toBe(1);
    expect(client.comments).toHaveLength(1);
    // Screenshot inline via raw; video via blob-view player — both open in a tab, no download.
    expect(client.comments[0]).toContain('raw.githubusercontent.com/o/r/awb/feature/.awb/qa/screenshot.png');
    expect(client.comments[0]).toContain('github.com/o/r/blob/awb/feature/.awb/qa/recording.webm');
    expect(client.comments[0]).not.toContain('undefined');
  });

  it('uploads the trace as a release asset and links it for download (no in-browser viewer)', async () => {
    const client = fakeClient();
    const uploader = fakeUploader(() => ({
      commentId: 'x',
      attachmentUrl: 'https://github.com/o/r/releases/download/awb-qa-2/2-trace.zip',
    }));

    const result = await postQaMediaBriefs({
      ...base,
      committedMedia: [{ kind: 'qa-video', repoPath: '.awb/qa/recording.webm' }],
      traceFiles: [traceFile()],
      uploader,
      client,
    });

    expect(result.requiredVideosUploaded).toBe(true);
    expect(result.postedCount).toBe(1);
    expect(client.comments[0]).toContain('releases/download/awb-qa-2/2-trace.zip');
    expect(client.comments[0]).toContain('show-trace');
  });

  // Regression guard: the trace uploader returning undefined must NOT print a broken link.
  it('treats an undefined trace attachmentUrl as a failed upload (no undefined link)', async () => {
    const client = fakeClient();
    const uploader = fakeUploader(() => ({ commentId: 'x', attachmentUrl: undefined as unknown as string }));

    const result = await postQaMediaBriefs({
      ...base,
      committedMedia: [{ kind: 'qa-video', repoPath: '.awb/qa/recording.webm' }],
      traceFiles: [traceFile()],
      uploader,
      client,
    });

    expect(result.requiredVideosUploaded).toBe(false);
    // The video comment still posts; the trace is simply omitted (not an undefined link).
    expect(client.comments[0]).not.toContain('undefined');
  });

  it('treats a thrown trace upload as a failed upload', async () => {
    const client = fakeClient();
    const uploader = fakeUploader(() => 'throw');

    const result = await postQaMediaBriefs({
      ...base,
      committedMedia: [{ kind: 'qa-video', repoPath: '.awb/qa/recording.webm' }],
      traceFiles: [traceFile()],
      uploader,
      client,
    });

    expect(result.requiredVideosUploaded).toBe(false);
  });

  it('is vacuously satisfied and posts nothing when there is no media', async () => {
    const client = fakeClient();
    const uploader = fakeUploader(() => ({ commentId: 'x', attachmentUrl: 'u' }));

    const result = await postQaMediaBriefs({ ...base, committedMedia: [], traceFiles: [], uploader, client });

    expect(result.requiredVideosUploaded).toBe(true);
    expect(result.postedCount).toBe(0);
    expect(client.comments).toHaveLength(0);
  });
});

describe('qaMediaFileName', () => {
  it('names by kind with the extension from mediaType', () => {
    expect(qaMediaFileName({ kind: 'qa-video', mediaType: 'video/webm' } as ArtifactRecord)).toBe('recording.webm');
    expect(qaMediaFileName({ kind: 'screenshot', mediaType: 'image/png' } as ArtifactRecord)).toBe('screenshot.png');
  });
});
