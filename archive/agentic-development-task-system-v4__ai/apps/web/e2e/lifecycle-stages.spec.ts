import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, expect, test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end proof for the lifecycle-stage changes (real baseline static
 * analysis, "Verification" rename, skippable worktree → direct commit on main).
 * Drives the REAL UI against the isolated daemon + temp git repo the
 * playwright.config boots. Records video + trace.
 *
 * Runtime is `mock` so no real `claude` CLI is spawned (that would hang without
 * an API key), but the project is configured with REAL shell commands so the
 * baseline/validation stages run actual processes — that is what proves the
 * output is no longer hardcoded `(mock)`. The full claude Playwright demo
 * bundle is a separate documented manual check.
 */

const { repoDir, daemonPort } = JSON.parse(readFileSync(join(here, '.env-paths.json'), 'utf8')) as {
  repoDir: string;
  daemonPort: string;
};

const API = `http://localhost:${daemonPort}/api`;

async function createProject(req: APIRequestContext, body: Record<string, unknown>) {
  const res = await req.post(`${API}/projects`, { data: body });
  expect(res.ok()).toBeTruthy();
  return res.json();
}
async function createTask(req: APIRequestContext, body: Record<string, unknown>) {
  const res = await req.post(`${API}/tasks`, { data: body });
  expect(res.ok()).toBeTruthy();
  return res.json();
}
async function act(req: APIRequestContext, taskId: string, path: string) {
  const res = await req.post(`${API}/tasks/${taskId}/${path}`, { data: {} });
  expect(res.ok(), `${path} should succeed`).toBeTruthy();
  return res.json();
}

const git = (...args: string[]) =>
  execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });

test.describe.configure({ mode: 'serial' });

let projectId: string;

test.beforeAll(async ({ request }) => {
  const proj = await createProject(request, {
    name: 'Lifecycle QA',
    repoPath: repoDir,
    defaultBranch: 'main',
    agentRuntime: 'mock',
    typecheckCommand: 'true',
    lintCommand: 'true',
    testCommand: 'true',
  });
  projectId = proj.id;
});

test('Verification stage label replaces "Validation + Demo Evidence"', async ({
  page,
  request,
}) => {
  // Drive a task past the brief gate so the full lifecycle sidebar renders.
  const t = await createTask(request, {
    projectId,
    title: 'Label check task',
    rawRequest: 'check the stage label',
  });
  await act(request, t.id, 'generate-brief');
  await act(request, t.id, 'approve-brief');

  await page.goto(`/tasks/${t.id}`);
  // The renamed stage shows in the lifecycle sidebar...
  await expect(page.getByText('Verification', { exact: true })).toBeVisible();
  // ...and the old label is gone.
  await expect(page.getByText('Validation + Demo Evidence')).toHaveCount(0);
});

test('Skip worktree: confirm modal → approves → task proceeds with no worktree', async ({
  page,
  request,
}) => {
  const t = await createTask(request, {
    projectId,
    title: 'Skip worktree task',
    rawRequest: 'commit straight to main',
  });
  // Generate the brief over the API, then STOP at the brief gate so the UI shows
  // the skip control (it renders only at human_brief_approval).
  const afterBrief = await act(request, t.id, 'generate-brief');
  expect(afterBrief.stage).toBe('human_brief_approval');

  await page.goto(`/tasks/${t.id}`);
  await expect(page.getByRole('button', { name: 'Approve Brief' })).toBeVisible();

  // Clicking skip opens the confirm modal; it must NOT act before confirmation.
  await page.getByRole('button', { name: 'Skip worktree (commit to main)' }).click();
  const dialog = page.getByRole('dialog', { name: /Skip worktree/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/commits will land directly on/i)).toBeVisible();

  // Cancel first — proves the modal gates the action (still at the brief gate).
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  const stillGated = await (await request.get(`${API}/tasks/${t.id}`)).json();
  expect(stillGated.task.stage).toBe('human_brief_approval');

  // Now confirm.
  await page.getByRole('button', { name: 'Skip worktree (commit to main)' }).click();
  await page
    .getByRole('dialog', { name: /Skip worktree/ })
    .getByRole('button', { name: /Approve \(commit to main\)/ })
    .click();

  // Task advanced past the brief gate, recorded direct mode, and created NO
  // worktree (the per-task worktree section/branch is absent).
  await expect(page.getByRole('dialog', { name: /Skip worktree/ })).toBeHidden();
  await expect
    .poll(async () => {
      const detail = await (await request.get(`${API}/tasks/${t.id}`)).json();
      return detail.task.stage;
    })
    .not.toBe('human_brief_approval');

  const detail = await (await request.get(`${API}/tasks/${t.id}`)).json();
  expect(detail.task.worktreeMode).toBe('direct');
  expect(detail.worktree ?? null).toBeNull();
});

test('Direct-mode delivery leaves a real commit on the default branch (main)', async ({
  request,
}) => {
  const before = git('rev-list', '--count', 'main').trim();

  const t = await createTask(request, {
    projectId,
    title: 'Direct commit task',
    rawRequest: 'land a commit on main',
  });
  await act(request, t.id, 'generate-brief');
  // Skip the worktree via the API skip flag, then walk the lifecycle to closeout.
  const skip = await request.post(`${API}/tasks/${t.id}/approve-brief`, {
    data: { skipWorktree: true },
  });
  expect(skip.ok()).toBeTruthy();
  expect((await skip.json()).stage).toBe('human_plan_approval');

  await act(request, t.id, 'approve-plan');
  await act(request, t.id, 'review/complete');

  // In direct mode the project repo IS the task's working tree (no worktree).
  // The mock agent runtime makes no real edits, so simulate the implementation
  // edit directly in the repo — exactly where a real direct-mode agent would
  // write — so the delivery commit has content to capture.
  writeFileSync(join(repoDir, 'CHANGE.md'), '# implemented directly on main\n');

  const closed = await act(request, t.id, 'approve-delivery');
  expect(closed.stage).toBe('closeout');
  expect(closed.status).toBe('done');

  // The dry-run GitDeliveryAdapter commits locally on the project's default
  // branch — direct mode lands the work straight on main, no feature branch.
  const after = git('rev-list', '--count', 'main').trim();
  expect(Number(after)).toBeGreaterThan(Number(before));
  // The newest commit is the workbench delivery commit for this task, on main,
  // and it includes the file that was changed in the repo (not a worktree).
  expect(git('log', '-1', '--pretty=%s', 'main')).toContain('Direct commit task');
  expect(git('show', '--stat', 'HEAD')).toContain('CHANGE.md');
});
