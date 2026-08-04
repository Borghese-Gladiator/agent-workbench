import type { GitHubClient, GitHubMediaUploader, QaMediaItem } from '@awb/github';
import { renderQaMediaSection } from '@awb/github';
import type { ArtifactRecord } from '@awb/domain';

export interface QaMediaFile {
  record: ArtifactRecord;
  path: string;
}

/** A branch-committed media file: its kind + the repo-relative path it was committed under. */
export interface CommittedQaMedia {
  kind: string;
  repoPath: string;
}

export interface PostQaMediaInput {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  branch: string;
  /** Screenshot/video already committed to the PR branch (in-tab viewable links). */
  committedMedia: CommittedQaMedia[];
  /** Trace artifacts to host as release assets (download link — no in-browser viewer). */
  traceFiles: QaMediaFile[];
  /** One-line description of what QA exercised, for the media section. */
  qaSummary?: string;
  uploader: GitHubMediaUploader;
  client: Pick<GitHubClient, 'postComment'>;
}

export interface PostQaMediaResult {
  /** False if a trace upload failed (returned no usable URL or threw). */
  requiredVideosUploaded: boolean;
  /** Number of QA-media sections actually posted (0 or 1 — one consolidated comment). */
  postedCount: number;
}

/**
 * Posts ONE consolidated QA-media comment linking each artifact in a form the reviewer can open in a
 * browser TAB where GitHub allows it (release-asset links cannot — GitHub always serves them as
 * forced downloads):
 *   - screenshot + video: already committed to the PR branch by the caller (see
 *     `commitQaMediaToBranch`); linked via the raw image URL (renders inline) and the video's
 *     blob-view page (GitHub's native in-tab player).
 *   - browser-trace: uploaded here as a release asset (download link); a Playwright trace has no
 *     in-browser viewer, so it must be downloaded and opened with `npx playwright show-trace`.
 *
 * `requiredVideosUploaded` reflects real success of the trace upload (branch-media success is the
 * caller's commit result). A run with no trace is vacuously satisfied.
 */
export async function postQaMediaBriefs(input: PostQaMediaInput): Promise<PostQaMediaResult> {
  const items: QaMediaItem[] = input.committedMedia.map((m) => ({ kind: m.kind, repoPath: m.repoPath }));
  let requiredVideosUploaded = true;

  for (const media of input.traceFiles) {
    try {
      const uploaded = await input.uploader.uploadToPullRequest({
        owner: input.owner,
        repository: input.repo,
        pullRequestNumber: input.pullRequestNumber,
        filePath: media.path,
        caption: media.record.kind,
        mediaType: media.record.mediaType,
      });
      if (!uploaded.attachmentUrl) {
        requiredVideosUploaded = false;
        continue;
      }
      items.push({ kind: 'browser-trace', downloadUrl: uploaded.attachmentUrl });
    } catch {
      requiredVideosUploaded = false;
    }
  }

  const body = renderQaMediaSection({
    ref: { owner: input.owner, repo: input.repo },
    branch: input.branch,
    qaSummary: input.qaSummary,
    items,
  });
  let postedCount = 0;
  if (body.length > 0) {
    await input.client.postComment({
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullRequestNumber,
      body,
    });
    postedCount = 1;
  }

  return { requiredVideosUploaded, postedCount };
}

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'video/webm': '.webm',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
};

/** File name (with extension) to commit a screenshot/video artifact under `.awb/qa/`. */
export function qaMediaFileName(record: ArtifactRecord): string {
  const ext = EXT_BY_MEDIA_TYPE[record.mediaType] ?? '';
  const base =
    record.kind === 'qa-video-gif'
      ? 'recording'
      : record.kind === 'qa-video'
        ? 'recording'
        : record.kind === 'screenshot'
          ? 'screenshot'
          : record.kind;
  return `${base}${ext}`;
}
