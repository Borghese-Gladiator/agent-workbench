import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitQaMediaToBranch } from './qa-media-commit.js';

const execFileAsync = promisify(execFile);

describe('commitQaMediaToBranch', () => {
  let repo: string;
  let src: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'awb-qa-commit-'));
    await execFileAsync('git', ['init', '-q'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 't'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), '# base\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'base'], { cwd: repo });

    src = await mkdtemp(join(tmpdir(), 'awb-qa-src-'));
    await writeFile(join(src, 'blobA'), 'png bytes');
    await writeFile(join(src, 'blobB'), 'webm bytes');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(src, { recursive: true, force: true });
  });

  it('copies media under .awb/qa, commits it, and returns repo-relative paths', async () => {
    const result = await commitQaMediaToBranch({
      worktreePath: repo,
      files: [
        { srcPath: join(src, 'blobA'), name: 'screenshot.png' },
        { srcPath: join(src, 'blobB'), name: 'recording.webm' },
      ],
    });

    expect(result.committed).toBe(true);
    expect(result.committedPaths).toEqual(['.awb/qa/screenshot.png', '.awb/qa/recording.webm']);

    // Files exist in the worktree with the original bytes.
    expect(await readFile(join(repo, '.awb/qa/screenshot.png'), 'utf8')).toBe('png bytes');
    // .gitattributes marks the dir generated so GitHub collapses it in the PR diff.
    expect(await readFile(join(repo, '.awb/qa/.gitattributes'), 'utf8')).toContain('linguist-generated');

    // A commit was actually made and the media is tracked.
    const { stdout: log } = await execFileAsync('git', ['log', '--oneline'], { cwd: repo });
    expect(log).toContain('attach QA media');
    const { stdout: tracked } = await execFileAsync('git', ['ls-files', '.awb/qa'], { cwd: repo });
    expect(tracked).toContain('.awb/qa/recording.webm');
  });

  it('is a no-op when there are no files', async () => {
    const before = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    const result = await commitQaMediaToBranch({ worktreePath: repo, files: [] });
    const after = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    expect(result).toEqual({ committedPaths: [], committed: false });
    expect(after).toBe(before);
  });

  it('honors a custom media dir', async () => {
    const result = await commitQaMediaToBranch({
      worktreePath: repo,
      mediaDir: 'qa-artifacts',
      files: [{ srcPath: join(src, 'blobA'), name: 'shot.png' }],
    });
    expect(result.committedPaths).toEqual(['qa-artifacts/shot.png']);
  });
});
