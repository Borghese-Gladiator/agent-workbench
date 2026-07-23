import type { GitHubClient, GitHubMediaUploader } from '@awb/github';
import { renderQaMediaBrief } from '@awb/github';
import type { ArtifactRecord } from '@awb/domain';

export interface QaMediaFile {
  record: ArtifactRecord;
  path: string;
}

export interface PostQaMediaInput {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  mediaFiles: QaMediaFile[];
  /** One-line description of what QA exercised, for the media brief. */
  qaSummary?: string;
  uploader: GitHubMediaUploader;
  client: Pick<GitHubClient, 'postComment'>;
}

export interface PostQaMediaResult {
  /** False if any media upload failed (threw, or returned no usable download URL). */
  requiredVideosUploaded: boolean;
  /** Number of descriptive briefs actually posted (only for uploads that yielded a real URL). */
  postedCount: number;
}

/**
 * Uploads each QA-media artifact as a release asset and posts a DESCRIPTIVE brief comment linking
 * it. Extracted from run-phase's release step so the failure handling is directly testable.
 *
 * Two failure modes are handled — both proven against the real API on PR #2, where the release was
 * created but had 0 assets and the uploader returned `browser_download_url: undefined` WITHOUT
 * throwing:
 *   - the upload throws  → caught, counts as a failed upload;
 *   - the upload returns an empty/undefined `attachmentUrl` → counts as a failed upload.
 * In neither case do we post a comment with an `undefined` link (the observed regression). A run
 * with no media is vacuously satisfied (requiredVideosUploaded stays true, postedCount 0).
 */
export async function postQaMediaBriefs(input: PostQaMediaInput): Promise<PostQaMediaResult> {
  let requiredVideosUploaded = true;
  let postedCount = 0;

  for (const media of input.mediaFiles) {
    try {
      const uploaded = await input.uploader.uploadToPullRequest({
        owner: input.owner,
        repository: input.repo,
        pullRequestNumber: input.pullRequestNumber,
        filePath: media.path,
        caption: media.record.kind,
      });
      if (!uploaded.attachmentUrl) {
        requiredVideosUploaded = false;
        continue;
      }
      await input.client.postComment({
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pullRequestNumber,
        body: renderQaMediaBrief({ kind: media.record.kind, qaSummary: input.qaSummary, mediaUrl: uploaded.attachmentUrl }),
      });
      postedCount += 1;
    } catch {
      requiredVideosUploaded = false;
    }
  }

  return { requiredVideosUploaded, postedCount };
}
