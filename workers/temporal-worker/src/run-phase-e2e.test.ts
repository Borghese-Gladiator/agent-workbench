import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TaskWorkflow,
  approveContractUpdate,
  pullRequestMergedSignal,
  getCurrentStateQuery,
} from '@awb/workflow';
import { runPhase } from './activities/run-phase.js';

const execFileAsync = promisify(execFile);

/**
 * Minimal real-git fixture builder, mirroring the established `makeTempRepo` /
 * `writeFileEnsuringDir` / `commitAll` pattern used across `@awb/repository` and `@awb/workspace`'s
 * own test-helpers (neither module exports these publicly, so this is a self-contained local copy
 * scoped to this test file rather than a cross-package import).
 */
async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'awb-e2e-repo-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

async function writeFileEnsuringDir(rootDir: string, relativePath: string, contents: string): Promise<void> {
  const fullPath = join(rootDir, relativePath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, contents, 'utf8');
}

async function commitAll(dir: string, message: string): Promise<string> {
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', message], { cwd: dir });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 20_000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitForCondition timed out');
}

let testEnv: TestWorkflowEnvironment;
let repoDir: string;

beforeAll(async () => {
  // createLocal (real-time), matching packages/workflow/src/task-workflow.test.ts's established
  // rationale: these tests drive the workflow with wall-clock polling from outside, so
  // time-skipping fights the test driver and produces spurious timeouts.
  testEnv = await TestWorkflowEnvironment.createLocal();

  repoDir = await makeTempRepo();
  await writeFileEnsuringDir(repoDir, 'README.md', '# fixture repo for runPhase e2e test\n');
  await commitAll(repoDir, 'initial commit');
}, 60_000);

afterAll(async () => {
  await testEnv?.teardown();
});

describe('runPhase wired for real (E2E through TaskWorkflow)', () => {
  it('drives the full 9-phase lifecycle to completion using the real runPhase Activity', async () => {
    const taskId = `e2e-task-${Date.now()}`;
    const repositoryId = 'e2e-repo';
    const taskQueue = `awb-run-phase-e2e-${Date.now()}`;

    // Points the Activity's simplified "prepare" placeholder at a real temp git repo, so verify
    // (runVerificationMatrix) and exercise (runCliQa) execute their real commands against a real
    // filesystem/git context rather than this worker process's own cwd.
    process.env.AWB_RUN_PHASE_FIXTURE_REPO = repoDir;

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      // TaskWorkflow itself is unchanged (built by an earlier milestone) — only runPhase, this
      // task's actual deliverable, is real here (not a scripted fake).
      workflowsPath: new URL('../../../packages/workflow/dist/task-workflow.js', import.meta.url).pathname,
      activities: { runPhase },
    });

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(TaskWorkflow, {
        taskQueue,
        workflowId: `test-run-phase-${taskId}`,
        args: [{ taskId, repositoryId }],
      });

      await waitForCondition(async () => {
        const state = await handle.query(getCurrentStateQuery);
        return state.phase === 'specify' && state.condition === 'awaiting-human';
      });
      await handle.executeUpdate(approveContractUpdate, { args: [{ contractVersion: 1 }] });

      await waitForCondition(async () => {
        const state = await handle.query(getCurrentStateQuery);
        return state.phase === 'release' && state.condition === 'awaiting-human';
      }, 30_000);
      await handle.signal(pullRequestMergedSignal, { mergeCommitSha: 'e2e-merge-sha' });

      return handle.result();
    });

    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
    expect(result.deliveryState).toBe('merged');
  }, 60_000);
});
