import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskWorkflow, getCurrentStateQuery } from '@awb/workflow';
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
}, 120_000);

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

    // Autonomy pivot (TASK-104): no human gates. The run self-approves its contract at specify and
    // opens a terminal draft PR at release — it drives to completion with NO awaiting-human stops.
    let sawAwaitingHuman = false;
    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(TaskWorkflow, {
        taskQueue,
        workflowId: `test-run-phase-${taskId}`,
        args: [{ taskId, repositoryId }],
      });

      // Poll until the workflow completes, recording whether it ever parked on a human.
      await waitForCondition(async () => {
        try {
          const state = await handle.query(getCurrentStateQuery);
          if (state.condition === 'awaiting-human') sawAwaitingHuman = true;
          return state.phase === 'assimilate';
        } catch {
          return true; // completed/terminated — query no longer available
        }
      }, 90_000);

      return handle.result();
    });

    expect(sawAwaitingHuman).toBe(false);
    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
  }, 120_000);

  it('runs the real program-design phase for an L task (size override at the gate) (TASK-51/52)', async () => {
    const taskId = `e2e-l-task-${Date.now()}`;
    const repositoryId = 'e2e-repo';
    const taskQueue = `awb-run-phase-e2e-l-${Date.now()}`;
    process.env.AWB_RUN_PHASE_FIXTURE_REPO = repoDir;

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../../packages/workflow/dist/task-workflow.js', import.meta.url).pathname,
      activities: { runPhase },
    });

    // Size is seeded via the intake hint (no gate to override at) so the run walks program-design.
    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(TaskWorkflow, {
        taskQueue,
        workflowId: `test-run-phase-l-${taskId}`,
        args: [{ taskId, repositoryId, size: 'L' }],
      });

      await waitForCondition(async () => {
        try {
          const state = await handle.query(getCurrentStateQuery);
          return state.phase === 'assimilate';
        } catch {
          return true;
        }
      }, 90_000);
      return handle.result();
    });

    // The run reaching assimilate for an L phase set is itself proof the real program-design phase ran.
    expect(result.size).toBe('L');
    expect(result.phaseSet).toContain('program-design');
    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
  }, 120_000);

  it('single-shots an S task through the real implement phase with no plan phase (TASK-51)', async () => {
    const taskId = `e2e-s-task-${Date.now()}`;
    const repositoryId = 'e2e-repo';
    const taskQueue = `awb-run-phase-e2e-s-${Date.now()}`;
    process.env.AWB_RUN_PHASE_FIXTURE_REPO = repoDir;

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../../../packages/workflow/dist/task-workflow.js', import.meta.url).pathname,
      activities: { runPhase },
    });

    // Seed S via the intake hint: the run must skip plan AND program-design and single-shot to implement.
    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(TaskWorkflow, {
        taskQueue,
        workflowId: `test-run-phase-s-${taskId}`,
        args: [{ taskId, repositoryId, size: 'S' }],
      });

      await waitForCondition(async () => {
        try {
          const state = await handle.query(getCurrentStateQuery);
          return state.phase === 'assimilate';
        } catch {
          return true;
        }
      }, 90_000);
      return handle.result();
    });

    // Reaching assimilate with an S phase set proves the synthesized single-shot plan let implement
    // complete WITHOUT a plan phase — the S single-shot bug (implement blocking on a missing plan) is fixed.
    expect(result.size).toBe('S');
    expect(result.phaseSet).not.toContain('plan');
    expect(result.phaseSet).not.toContain('program-design');
    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
  }, 120_000);
});
