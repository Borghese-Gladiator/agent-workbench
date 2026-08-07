import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDefaultBranch,
  getHeadSha,
  getRecentHistory,
  getRemotes,
  getStatus,
  getChangedPaths,
  getDiffLineStats,
  parseNumstat,
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

  it('computes added/removed line counts between two revisions', async () => {
    await writeFileEnsuringDir(dir, 'a.txt', 'one\ntwo\n');
    const first = await commitAll(dir, 'first');
    await writeFileEnsuringDir(dir, 'a.txt', 'one\ntwo\nthree\n');
    await writeFileEnsuringDir(dir, 'b.txt', 'new\n');
    const second = await commitAll(dir, 'second');
    expect(await getDiffLineStats(dir, first, second)).toEqual({ added: 2, removed: 0, filesChanged: 2 });
  });
});

describe('parseNumstat', () => {
  it('sums added/removed and counts files', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\n0\t5\tsrc/b.ts')).toEqual({ added: 3, removed: 6, filesChanged: 2 });
  });

  it('treats a binary file (-\\t-) as a changed file with zero line deltas', () => {
    expect(parseNumstat('-\t-\tassets/logo.png\n2\t0\tREADME.md')).toEqual({
      added: 2,
      removed: 0,
      filesChanged: 2,
    });
  });

  it('returns zeros for an empty diff', () => {
    expect(parseNumstat('')).toEqual({ added: 0, removed: 0, filesChanged: 0 });
  });
});
