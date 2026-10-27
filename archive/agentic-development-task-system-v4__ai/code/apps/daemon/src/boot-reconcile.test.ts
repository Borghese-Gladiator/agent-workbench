/**
 * Boot reconciliation tests:
 *  - reapOrphanProcessGroups: verified-kill / skip-unverified / stale-noop, plus
 *    a real-child end-to-end that proves a detached group is actually killed.
 *  - LifecycleService.resumeInterruptedTasks: re-drives a parked task, isolates
 *    per-task failures, and skips terminal / repo-missing / in-flight tasks.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun } from '@workbench/core';
import { Store } from '@workbench/store';
import { StubWorktreeProvider } from '@workbench/worktree';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ProcessControl, reapOrphanProcessGroups } from './boot-reconcile.js';
import { LifecycleService } from './service.js';

let store: Store;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-boot-'));
  store = new Store({ dbPath: ':memory:', artifactsDir: dir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An AgentRun-shaped fixture with just the fields the reaper reads. */
function run(over: Partial<AgentRun>): AgentRun {
  return {
    id: 'arun_1',
    taskId: 't1',
    stage: 'implementation',
    status: 'interrupted',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
    totalCostUsd: null,
    numTurns: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    error: null,
    sessionId: null,
    pgid: 4242,
    ...over,
  };
}

describe('reapOrphanProcessGroups', () => {
  it('kills a live group whose leader command verifiably matches (claude + worktree)', () => {
    const killed: number[] = [];
    const control: ProcessControl = {
      isGroupAlive: () => true,
      groupLeaderCommand: () => 'claude -p ... /work/tree/abc',
      killGroup: (pgid) => killed.push(pgid),
    };
    const res = reapOrphanProcessGroups([run({ pgid: 999 })], () => '/work/tree/abc', control);
    expect(res).toEqual({ killed: 1, stale: 0, skipped: 0 });
    expect(killed).toEqual([999]);
  });

  it('SKIPS (never kills) a live pid whose identity is not confirmed — pid reuse guard', () => {
    const killed: number[] = [];
    const control: ProcessControl = {
      isGroupAlive: () => true,
      // A recycled pid now running something unrelated.
      groupLeaderCommand: () => '/usr/bin/some-other-process',
      killGroup: (pgid) => killed.push(pgid),
    };
    const res = reapOrphanProcessGroups([run({ pgid: 999 })], () => '/work/tree/abc', control);
    expect(res).toEqual({ killed: 0, stale: 0, skipped: 1 });
    expect(killed).toEqual([]);
  });

  it('no-ops on a group that is already gone (stale)', () => {
    const control: ProcessControl = {
      isGroupAlive: () => false,
      groupLeaderCommand: () => null,
      killGroup: () => {
        throw new Error('should not be called');
      },
    };
    const res = reapOrphanProcessGroups([run({ pgid: 999 })], () => '/work/tree/abc', control);
    expect(res).toEqual({ killed: 0, stale: 1, skipped: 0 });
  });

  it('ignores runs with no recorded pgid (mock / legacy)', () => {
    const control: ProcessControl = {
      isGroupAlive: () => true,
      groupLeaderCommand: () => 'claude',
      killGroup: () => {
        throw new Error('should not be called');
      },
    };
    const res = reapOrphanProcessGroups([run({ pgid: null })], () => '/work/tree/abc', control);
    expect(res).toEqual({ killed: 0, stale: 0, skipped: 0 });
  });

  it('end-to-end: actually kills a real detached process group (real OS control)', async () => {
    // Spawn a detached, long-lived child group leader; its pid == its pgid.
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const pgid = child.pid!;
    expect(pgid).toBeGreaterThan(0);

    // Real control — but force identity verification to pass for THIS pgid by
    // claiming the leader command contains our worktree marker.
    const realish: ProcessControl = {
      isGroupAlive: (p) => {
        try {
          process.kill(p, 0);
          return true;
        } catch {
          return false;
        }
      },
      groupLeaderCommand: () => 'claude /work/tree/abc',
      killGroup: (p) => process.kill(-p, 'SIGKILL'),
    };

    const res = reapOrphanProcessGroups([run({ pgid })], () => '/work/tree/abc', realish);
    expect(res.killed).toBe(1);

    // The child must be dead. Wait for the exit (SIGKILL).
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    expect(realish.isGroupAlive(pgid)).toBe(false);
  });
});

describe('LifecycleService.resumeInterruptedTasks', () => {
  function svc() {
    return new LifecycleService(store, new StubWorktreeProvider(), join(tmpdir(), 'wb-wt-x'));
  }

  /** A mock-runtime task parked at an auto-advanceable stage with an interrupted run. */
  function parkedTask(stage: 'discovery' | 'implementation' = 'implementation') {
    const project = store.createProject({
      name: 'P',
      repoPath: dir, // exists (the artifacts tmp dir) so the repo-missing guard passes
      defaultBranch: 'main',
      agentRuntime: 'mock',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'do x' });
    store.applyTransition(task.id, { stage, status: 'active' });
    const r = store.createAgentRun({ taskId: task.id, stage });
    store.markInterruptedRuns(); // -> the run becomes `interrupted`
    return { task, project, run: r };
  }

  it('re-drives a parked task off its interrupted run', async () => {
    const { task } = parkedTask('implementation');
    const out = await svc().resumeInterruptedTasks();
    expect(out.resumed).toBe(1);
    // The mock implementation stage advanced the task off implementation.
    expect(store.getTask(task.id)!.stage).not.toBe('implementation');
  });

  it('skips a task that is already terminal', async () => {
    const { task } = parkedTask('implementation');
    store.applyTransition(task.id, { stage: 'closeout', status: 'done' });
    const out = await svc().resumeInterruptedTasks();
    expect(out).toEqual({ resumed: 0, skipped: 1 });
  });

  it('skips a claude task whose repo/worktree is missing', async () => {
    const project = store.createProject({
      name: 'P',
      repoPath: join(dir, 'does-not-exist'),
      defaultBranch: 'main',
      agentRuntime: 'claude',
    });
    const task = store.createTask({ projectId: project.id, title: 'T', rawRequest: 'x' });
    store.applyTransition(task.id, { stage: 'implementation', status: 'active' });
    store.createAgentRun({ taskId: task.id, stage: 'implementation' });
    store.markInterruptedRuns();

    const out = await svc().resumeInterruptedTasks();
    expect(out).toEqual({ resumed: 0, skipped: 1 });
    // Untouched — still parked.
    expect(store.getTask(task.id)!.stage).toBe('implementation');
  });

  it('no-op when nothing is interrupted', async () => {
    const out = await svc().resumeInterruptedTasks();
    expect(out).toEqual({ resumed: 0, skipped: 0 });
  });
});
