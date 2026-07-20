import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDefaultBranch,
  getHeadSha,
  getRecentHistory,
  getRemotes,
  getStatus,
  getChangedPaths,
  isGitRepository,
} from './git.js';
import { makeTempRepo, writeFileEnsuringDir, commitAll } from './test-helpers.js';

describe('git inspection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('recognizes a real git repository and rejects a non-repository directory', async () => {
    expect(await isGitRepository(dir)).toBe(true);
    const nonRepo = await import('node:os').then((os) => os.tmpdir());
    expect(await isGitRepository(nonRepo)).toBe(false);
  });

  it('resolves the default branch to the current local branch when no remote HEAD exists', async () => {
    await writeFileEnsuringDir(dir, 'README.md', '# test');
    await commitAll(dir, 'init');
    expect(await getDefaultBranch(dir)).toBe('main');
  });

  it('resolves HEAD sha', async () => {
    await writeFileEnsuringDir(dir, 'README.md', '# test');
    const sha = await commitAll(dir, 'init');
    expect(await getHeadSha(dir)).toBe(sha);
  });

  it('reports an empty remote list when none are configured', async () => {
    expect(await getRemotes(dir)).toEqual([]);
  });

  it('reports status for untracked and modified files', async () => {
    await writeFileEnsuringDir(dir, 'a.txt', 'a');
    await commitAll(dir, 'init');
    await writeFileEnsuringDir(dir, 'a.txt', 'a-modified');
    await writeFileEnsuringDir(dir, 'b.txt', 'b');
    const status = await getStatus(dir);
    const paths = status.map((s) => s.path).sort();
    expect(paths).toEqual(['a.txt', 'b.txt']);
  });

  it('returns recent history newest first', async () => {
    await writeFileEnsuringDir(dir, 'a.txt', 'a');
    const first = await commitAll(dir, 'first commit');
    await writeFileEnsuringDir(dir, 'a.txt', 'a2');
    const second = await commitAll(dir, 'second commit');
    const history = await getRecentHistory(dir, 10);
    expect(history[0]?.sha).toBe(second);
    expect(history[1]?.sha).toBe(first);
  });

  it('computes changed paths between two revisions', async () => {
    await writeFileEnsuringDir(dir, 'a.txt', 'a');
    const first = await commitAll(dir, 'first');
    await writeFileEnsuringDir(dir, 'b.txt', 'b');
    const second = await commitAll(dir, 'second');
    expect(await getChangedPaths(dir, first, second)).toEqual(['b.txt']);
  });
});
