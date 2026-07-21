import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHeadSha } from '@awb/repository';
import { resolveReviewDiff } from './command-support.js';

const execFileAsync = promisify(execFile);

describe('resolveReviewDiff (Fix 4: real review diff)', () => {
  let dir: string;
  let baseSha: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-review-diff-'));
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
    await writeFile(join(dir, 'README.md'), '# base\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
    baseSha = await getHeadSha(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the real diff text and changed paths between base and candidate', async () => {
    await writeFile(join(dir, 'engine.js'), 'export const play = () => 42;\n');
    await execFileAsync('git', ['add', '-A'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', 'add engine'], { cwd: dir });
    const candidateSha = await getHeadSha(dir);

    const { diff, changedPaths } = await resolveReviewDiff({ worktreePath: dir, baseSha, candidateSha });

    expect(diff).toContain('engine.js');
    expect(diff).toContain('export const play');
    expect(changedPaths).toContain('engine.js');
    expect(diff).not.toContain('PLACEHOLDER');
  });

  it('returns an empty diff gracefully on a git error (no crash)', async () => {
    const { diff, changedPaths } = await resolveReviewDiff({
      worktreePath: dir,
      baseSha: 'not-a-sha',
      candidateSha: 'also-not',
    });
    expect(diff).toBe('');
    expect(changedPaths).toEqual([]);
  });
});
