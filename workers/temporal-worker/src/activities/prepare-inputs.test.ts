import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceLease } from '@awb/domain';
import { computeRealPrepareInputs } from './run-phase.js';

const realSha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

function readyLease(worktreePath: string): WorkspaceLease {
  return {
    id: 'lease-1',
    repositoryId: 'repo-1',
    taskId: 'task-1',
    baseRef: 'main',
    baseSha: realSha,
    branchName: 'awb/task-1-x',
    worktreePath,
    executionProfile: 'native-trusted',
    allocatedPorts: {},
    state: 'ready',
    createdAt: '',
  };
}

describe('computeRealPrepareInputs (Fix 3)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-prepare-'));
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, 'README.md'), '# x\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports all inputs satisfied for a ready lease with a real worktree', async () => {
    const inputs = await computeRealPrepareInputs({
      lease: readyLease(dir),
      worktreePath: dir,
      baseSha: realSha,
    });
    expect(inputs.worktreeExists).toBe(true);
    expect(inputs.branchExists).toBe(true);
    expect(inputs.baseShaRecorded).toBe(true);
    expect(inputs.executionProfileApproved).toBe(true);
    expect(inputs.leaseActive).toBe(true);
  });

  it('reports worktree missing when the path does not exist', async () => {
    const inputs = await computeRealPrepareInputs({
      lease: readyLease('/no/such/path'),
      worktreePath: '/no/such/path',
      baseSha: realSha,
    });
    expect(inputs.worktreeExists).toBe(false);
    expect(inputs.branchExists).toBe(false);
  });

  it('reports baseShaRecorded false when no base SHA was captured', async () => {
    const inputs = await computeRealPrepareInputs({
      lease: readyLease(dir),
      worktreePath: dir,
      baseSha: undefined,
    });
    expect(inputs.baseShaRecorded).toBe(false);
  });

  it('reports leaseActive false when the lease is not ready/active', async () => {
    const inputs = await computeRealPrepareInputs({
      lease: { ...readyLease(dir), state: 'failed' },
      worktreePath: dir,
      baseSha: realSha,
    });
    expect(inputs.leaseActive).toBe(false);
  });
});
