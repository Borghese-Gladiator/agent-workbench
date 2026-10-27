import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBaseSha } from './base-sha.js';
import { commitAll, makeTempRepo, writeFileEnsuringDir } from './test-helpers.js';

describe('resolveBaseSha', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempRepo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves a branch ref to the current HEAD sha', async () => {
    await writeFileEnsuringDir(dir, 'README.md', '# test');
    const sha = await commitAll(dir, 'init');
    expect(await resolveBaseSha(dir, 'main')).toBe(sha);
  });

  it('resolves an already-a-sha ref to itself', async () => {
    await writeFileEnsuringDir(dir, 'README.md', '# test');
    const sha = await commitAll(dir, 'init');
    expect(await resolveBaseSha(dir, sha)).toBe(sha);
  });

  it('tracks history: resolves to the latest commit after a second commit', async () => {
    await writeFileEnsuringDir(dir, 'a.txt', 'a');
    await commitAll(dir, 'first');
    await writeFileEnsuringDir(dir, 'a.txt', 'a2');
    const second = await commitAll(dir, 'second');
    expect(await resolveBaseSha(dir, 'main')).toBe(second);
  });

  it('rejects an unresolvable ref', async () => {
    await writeFileEnsuringDir(dir, 'README.md', '# test');
    await commitAll(dir, 'init');
    await expect(resolveBaseSha(dir, 'does-not-exist')).rejects.toThrow();
  });
});
