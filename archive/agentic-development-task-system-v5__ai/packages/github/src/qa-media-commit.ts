import { execFile } from 'node:child_process';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface QaMediaCommitFile {
  /** Absolute path to the source blob (the ArtifactStore content-hash file). */
  srcPath: string;
  /** Destination file name under the media dir, WITH a real extension (e.g. `landing.png`). */
  name: string;
}

export interface CommitQaMediaInput {
  worktreePath: string;
  /** Repo-relative dir the media is committed under. Default `.awb/qa`. */
  mediaDir?: string;
  files: QaMediaCommitFile[];
}

export interface CommitQaMediaResult {
  /** Repo-relative paths of the committed media files (e.g. `.awb/qa/landing.png`). */
  committedPaths: string[];
  /** True when a commit was actually made (false when there were no files). */
  committed: boolean;
}

/**
 * Commits QA media into the PR branch so the reviewer can open it in a browser tab (raw image
 * renders inline; a committed video opens GitHub's native blob-view player) — unlike a release
 * asset, which GitHub always serves as a forced download. The media lands under `.awb/qa/` with a
 * `.gitattributes` marking it `linguist-generated`, so GitHub COLLAPSES these files in the PR diff
 * by default (they are QA artifacts, not part of the reviewed change).
 *
 * Runs `git add`/`git commit` in the worktree via the git CLI (never Octokit), consistent with the
 * push runner. Returns [] and makes no commit when `files` is empty.
 */
export async function commitQaMediaToBranch(input: CommitQaMediaInput): Promise<CommitQaMediaResult> {
  if (input.files.length === 0) return { committedPaths: [], committed: false };

  const mediaDir = input.mediaDir ?? '.awb/qa';
  const absMediaDir = join(input.worktreePath, mediaDir);
  await mkdir(absMediaDir, { recursive: true });

  const committedPaths: string[] = [];
  for (const file of input.files) {
    await copyFile(file.srcPath, join(absMediaDir, file.name));
    committedPaths.push(`${mediaDir}/${file.name}`);
  }

  // Collapse these files in the PR diff by default — they are generated QA artifacts.
  await writeFile(join(absMediaDir, '.gitattributes'), '* linguist-generated\n', 'utf8');

  await execFileAsync('git', ['add', mediaDir], { cwd: input.worktreePath });
  await execFileAsync(
    'git',
    ['commit', '-m', 'chore(qa): attach QA media (generated, not part of the change)'],
    { cwd: input.worktreePath },
  );

  return { committedPaths, committed: true };
}
