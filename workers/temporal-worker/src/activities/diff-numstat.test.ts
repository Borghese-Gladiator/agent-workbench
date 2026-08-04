import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHeadSha } from '@awb/repository';
import { resolveDiffNumstat } from './command-support.js';
import { sliceDiffExceedsCap } from './slice-guardrail.js';

const execFileAsync = promisify(execFile);

/** Real git fixture so resolveDiffNumstat + the guardrail are proven over actual `git diff --numstat`. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'awb-numstat-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# fixture\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

async function commit(dir: string, msg: string): Promise<string> {
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', msg], { cwd: dir });
  return getHeadSha(dir);
}

describe('resolveDiffNumstat (TASK-56)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('counts changed lines and files across a real base..head range', async () => {
    const base = await getHeadSha(repo);
    await writeFile(join(repo, 'a.txt'), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n');
    await writeFile(join(repo, 'b.txt'), Array.from({ length: 12 }, (_, i) => `x ${i}`).join('\n') + '\n');
    const head = await commit(repo, 'add two files');

    const stat = await resolveDiffNumstat({ worktreePath: repo, baseSha: base, headSha: head });
    expect(stat.changedFiles).toBe(2);
    expect(stat.changedLines).toBe(42);
  });

  it('a large real diff trips the cap; a small one does not', async () => {
    const base = await getHeadSha(repo);
    await writeFile(join(repo, 'big.txt'), Array.from({ length: 500 }, (_, i) => `l ${i}`).join('\n') + '\n');
    const head = await commit(repo, 'big change');
    const stat = await resolveDiffNumstat({ worktreePath: repo, baseSha: base, headSha: head });

    const cap = { enabled: true, lineCap: 400, fileCap: 20 };
    expect(sliceDiffExceedsCap(cap, stat)).toBe(true);
    // the same diff under a disabled cap (mock path) never trips
    expect(sliceDiffExceedsCap({ ...cap, enabled: false }, stat)).toBe(false);
  });

  it('returns zeros for an invalid range instead of throwing', async () => {
    const stat = await resolveDiffNumstat({ worktreePath: repo, baseSha: 'deadbeef', headSha: 'cafe' });
    expect(stat).toEqual({ changedLines: 0, changedFiles: 0 });
  });
});
