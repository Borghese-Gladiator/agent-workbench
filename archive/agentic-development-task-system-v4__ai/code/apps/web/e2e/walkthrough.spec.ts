import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, expect, test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The full UI-redesign walkthrough (the 10 manual steps from
 * docs/ui-redesign-plan.md), recorded as video + trace. Each test maps to one
 * or more steps; the suite runs serially against an isolated daemon.
 */

const { repoDir, daemonPort } = JSON.parse(readFileSync(join(here, '.env-paths.json'), 'utf8')) as {
  repoDir: string;
  daemonPort: string;
};

const API = `http://localhost:${daemonPort}/api`;

// --- API helpers (set up backend state the UI then displays) ---
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

test.describe.configure({ mode: 'serial' });

let realProjectId: string;
let gateTaskId: string;

test.beforeAll(async ({ request }) => {
  // Seed: one project on the temp git repo (worktree-capable) + a task driven
  // to the plan-approval gate so the gate + plan-markdown states have data.
  const proj = await createProject(request, {
    name: 'QA Real Repo',
    repoPath: repoDir,
    defaultBranch: 'main',
    agentRuntime: 'mock',
    testCommand: 'echo test',
  });
  realProjectId = proj.id;

  const task = await createTask(request, {
    projectId: realProjectId,
    title: 'Gate QA task',
    rawRequest: 'drive to plan gate',
  });
  gateTaskId = task.id;

  // intake -> ... -> human_plan_approval. Approving the brief creates the
  // worktree and auto-advances the non-gate stages (discovery -> baseline ->
  // plan), parking at the plan gate. The old per-stage routes were removed.
  await act(request, gateTaskId, 'generate-brief');
  const afterBrief = await act(request, gateTaskId, 'approve-brief');
  expect(afterBrief.stage).toBe('human_plan_approval');
});

test('step 1 — sidebar zones + Board shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Workflow')).toBeVisible();
  await expect(page.getByText('Config')).toBeVisible();
  await expect(page.getByRole('link', { name: /Task Board/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Projects/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Token Usage/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Task Board' })).toBeVisible();
  // No global clutter.
  await expect(page.getByText(/need human approval/i)).toHaveCount(0);
  await expect(page.getByRole('searchbox')).toHaveCount(0);
});

test('step 2 — Create Task modal creates a task and navigates to detail', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create task' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Walkthrough task');
  await dialog.getByRole('textbox', { name: 'Raw request' }).fill('made via the modal');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page).toHaveURL(/\/tasks\/.+/);
  await expect(page.getByRole('heading', { name: 'Walkthrough task' })).toBeVisible();
});

test('step 3 — Projects config-only registry + create modal', async ({ page }) => {
  await page.goto('/projects');
  for (const col of ['Project Name', 'Repository Path', 'Runtime', 'Build Commands']) {
    await expect(page.getByRole('columnheader', { name: col })).toBeVisible();
  }
  await expect(page.getByRole('columnheader', { name: /branch/i })).toHaveCount(0);
  await expect(page.getByText(/uptime|latency|coverage/i)).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'mock' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Name *' }).fill('Created In Modal');
  // The form submits agentRuntime 'claude', whose repoPath must exist (validated
  // on create), so point it at the real temp repo rather than a bogus path.
  await dialog.getByRole('textbox', { name: 'Repo path *' }).fill(repoDir);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('cell', { name: 'Created In Modal' })).toBeVisible();
});

test('step 4 — Token Usage table + session-count dropdown', async ({ page }) => {
  await page.goto('/usage');
  await expect(page.getByRole('columnheader', { name: 'Tokens' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Cost ($)' })).toBeVisible();
  await expect(page.getByText(/Total Tokens|Consumption Over Time|Quota/i)).toHaveCount(0);

  const bodyRows = page.locator('tbody tr');
  await expect(bodyRows).toHaveCount(10);
  await page.getByRole('combobox', { name: 'Recent sessions' }).click();
  await page.getByRole('option', { name: 'Last 25' }).click();
  await expect(bodyRows).toHaveCount(12); // capped skeleton, distinct from 10
});

test('steps 5 + 9 — Task Detail new-task worktree-create + intake reveals raw input', async ({
  page,
  request,
}) => {
  const t = await createTask(request, {
    projectId: realProjectId,
    title: 'Fresh task',
    rawRequest: 'the raw intake words',
  });
  await page.goto(`/tasks/${t.id}`);

  // Header: project, running cost counter, title, suppressed global top bar.
  await expect(page.getByText('QA Real Repo')).toBeVisible();
  await expect(page.getByText('cost')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fresh task' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create task' })).toHaveCount(0);

  // Center: worktree creation prominent.
  await expect(page.getByRole('heading', { name: 'Create the worktree' })).toBeVisible();

  // Step 9: clicking intake reveals the raw input.
  await expect(page.getByText('the raw intake words')).toHaveCount(0);
  await page.getByRole('button', { name: 'Intake' }).click();
  await expect(page.getByText('the raw intake words')).toBeVisible();
});

test('step 8 — Approval Gate dead-center; no removed panels', async ({ page }) => {
  await page.goto(`/tasks/${gateTaskId}`);
  await expect(page.getByRole('heading', { name: 'Approval required' })).toBeVisible();
  await expect(page.getByText('Stage: human_plan_approval')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve Plan' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject Plan' })).toBeVisible();
  // Removed Stitch panels must be absent.
  await expect(page.getByText(/Recent Approvals|System Health|Visual Graph|Export/i)).toHaveCount(
    0,
  );
});

test('steps 6 + 7 — approve plan → editable plan markdown center + open artifact', async ({
  page,
}) => {
  await page.goto(`/tasks/${gateTaskId}`);
  await page.getByRole('button', { name: 'Approve Plan' }).click();

  // Center swaps to the rendered/editable plan markdown.
  await expect(page.getByRole('heading', { level: 3, name: 'Execution Plan' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Chosen approach' })).toBeVisible();

  // Right column: clicking an artifact opens it dead-center (no dialog), with a
  // Copy button — main's TaskDetail rewrite replaced the artifact dialog with an
  // in-place center viewer.
  await page.getByRole('button', { name: '📄 Execution Plan' }).click();
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
});

test('step 10 — narrow width keeps the Board usable', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Task Board' })).toBeVisible();
  // Filtering still works at narrow width.
  await page.getByRole('combobox', { name: 'Filter by project' }).click();
  await page.getByRole('option', { name: 'QA Real Repo' }).click();
  await expect(page.getByText('Gate QA task')).toBeVisible();
  await expect(page.getByText('Add dark mode toggle')).toHaveCount(0);
});
