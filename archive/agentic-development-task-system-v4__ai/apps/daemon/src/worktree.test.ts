import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunInput, AgentRuntimeAdapter } from '@workbench/agents';
import { Store } from '@workbench/store';
import { branchFor, GitWorktreeProvider, worktreePathFor } from '@workbench/worktree';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

/**
 * A fast fake agent: these tests use the `claude` runtime purely to drive the
 * REAL git worktree provider, not the agent. Without this the lifecycle's agent
 * stages would shell out to the real `claude` CLI and hang.
 */
const fakeAgent = (): AgentRuntimeAdapter => ({
  async runStageAgent(input: AgentRunInput) {
    // feature_e2e gates on the Playwright JSON verdict — write a passing one.
    if (input.stage === 'feature_e2e' && input.env?.QA_OUTPUT_DIR) {
      mkdirSync(input.env.QA_OUTPUT_DIR, { recursive: true });
      writeFileSync(
        join(input.env.QA_OUTPUT_DIR, 'results.json'),
        JSON.stringify({ stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 } }),
      );
    }
    return {
      status: 'succeeded' as const,
      transcript: { kind: 'log' as const, title: 'run', body: 'fake transcript' },
      produced: [{ kind: 'log' as const, title: `${input.stage}`, body: `fake ${input.stage}` }],
    };
  },
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

let store: Store;
let artifactsDir: string;
let worktreesDir: string;
let repo: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'wb-art-'));
  worktreesDir = mkdtempSync(join(tmpdir(), 'wb-wt-'));
  repo = mkdtempSync(join(tmpdir(), 'wb-repo-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');

  store = new Store({ dbPath: ':memory:', artifactsDir });
  app = createApp(store, {
    worktrees: new GitWorktreeProvider(),
    worktreesDir,
    agentFor: () => fakeAgent(),
  });
});
afterEach(() => {
  store.close();
  for (const d of [artifactsDir, worktreesDir, repo]) rmSync(d, { recursive: true, force: true });
});

async function makeApprovedTask() {
  const p = await request(app)
    .post('/api/projects')
    // 'claude' runtime drives the real git worktree provider (the stub is for
    // mock projects only).
    .send({ name: 'Demo Proj', repoPath: repo, defaultBranch: 'main', agentRuntime: 'claude' });
  const t = await request(app)
    .post('/api/tasks')
    .send({ projectId: p.body.id, title: 'Add Dark Mode', rawRequest: 'r' });
  await request(app).post(`/api/tasks/${t.body.id}/generate-brief`).send({});
  return t.body.id as string;
}

// Real-git integration (worktree create/status/diff/remove + a lifecycle walk):
// runs longer than a unit test and must not race vitest's 5s default under
// parallel-worker CPU pressure. 30s headroom.
describe('daemon product shape (real git)', { timeout: 30_000 }, () => {
  it('walks Intake -> Brief Approval -> Discovery -> Plan Approval -> Review with a real worktree', async () => {
    const id = await makeApprovedTask(); // ends parked at human_brief_approval

    const step = async (path: string) => {
      const res = await request(app).post(`/api/tasks/${id}/${path}`).send({});
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
      return res.body;
    };

    // Brief is generated; task is parked at the first human gate.
    let detail = await request(app).get(`/api/tasks/${id}`);
    expect(detail.body.task.stage).toBe('human_brief_approval');
    expect(detail.body.worktree).toBeNull(); // no worktree before approval

    // Gate 1: approving the brief creates the worktree AND auto-advances
    // Discovery -> Baseline -> Plan, parking at the second human gate.
    expect((await step('approve-brief')).stage).toBe('human_plan_approval');
    detail = await request(app).get(`/api/tasks/${id}`);
    const wt = detail.body.worktree;
    expect(wt.status).toBe('created');
    // Assert against the production naming helper, not a re-derivation: the id is
    // `task_<nanoid>` and a nanoid can itself end in `_`/`-`, which `branchFor`
    // handles (falls back to the full id) but a hand-rolled slice does not.
    expect(wt.branch).toBe(branchFor(id, 'Add Dark Mode'));
    expect(existsSync(wt.worktreePath)).toBe(true);

    // Gate 2: approving the plan auto-advances Implementation -> Validation ->
    // Self-review, parking at Human Review.
    expect((await step('approve-plan')).stage).toBe('human_review');

    // The worktree persisted across the whole walk and the gates recorded approvals.
    detail = await request(app).get(`/api/tasks/${id}`);
    expect(detail.body.task.stage).toBe('human_review');
    expect(existsSync(detail.body.worktree.worktreePath)).toBe(true);
    const gates = detail.body.approvals.map((a: { gate: string }) => a.gate);
    expect(gates).toContain('task_brief');
    expect(gates).toContain('execution_plan');
  });
});

describe('daemon worktree API (real git)', { timeout: 30_000 }, () => {
  it('creates one branch + worktree at the expected location on brief approval', async () => {
    const id = await makeApprovedTask();
    const mainHeadBefore = git(repo, 'rev-parse', 'HEAD').trim();

    const approved = await request(app).post(`/api/tasks/${id}/approve-brief`).send({});
    expect(approved.status).toBe(200);

    const detail = await request(app).get(`/api/tasks/${id}`);
    const wt = detail.body.worktree;
    expect(wt.status).toBe('created');
    // Branch leads with the readable slug, then a short id suffix. Assert against
    // the production helper rather than re-deriving it (see note above). The
    // worktree path still embeds the full id for on-disk uniqueness.
    expect(wt.branch).toBe(branchFor(id, 'Add Dark Mode'));
    expect(wt.baseBranch).toBe('main');
    // The worktree lives beside the PROJECT repo (scoped by repo basename), not
    // inside the workbench data dir — assert against the production helper.
    expect(wt.worktreePath).toBe(worktreePathFor(repo, id, 'Add Dark Mode'));
    expect(wt.worktreePath).not.toContain(worktreesDir);
    expect(existsSync(wt.worktreePath)).toBe(true);

    // Main checkout untouched.
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(mainHeadBefore);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('refuses a second active worktree for the same task (409)', async () => {
    const id = await makeApprovedTask();
    await request(app).post(`/api/tasks/${id}/approve-brief`).send({});
    const second = await request(app).post(`/api/tasks/${id}/worktree`).send({});
    expect(second.status).toBe(409);
  });

  it('reports git status and diff for the worktree', async () => {
    const id = await makeApprovedTask();
    await request(app).post(`/api/tasks/${id}/approve-brief`).send({});
    const detail = await request(app).get(`/api/tasks/${id}`);
    const wt = detail.body.worktree.worktreePath;

    let status = await request(app).get(`/api/tasks/${id}/worktree/status`);
    expect(status.body.clean).toBe(true);

    writeFileSync(join(wt, 'README.md'), '# changed\n');
    status = await request(app).get(`/api/tasks/${id}/worktree/status`);
    expect(status.body.clean).toBe(false);
    expect(status.body.changedFiles.map((f: { path: string }) => f.path)).toContain('README.md');

    const diff = await request(app).get(`/api/tasks/${id}/worktree/diff`);
    expect(diff.body.diff).toContain('+# changed');
  });

  it('abandon removes the worktree; preserve keeps it', async () => {
    // Abandon path.
    const id1 = await makeApprovedTask();
    await request(app).post(`/api/tasks/${id1}/approve-brief`).send({});
    const wt1 = (await request(app).get(`/api/tasks/${id1}`)).body.worktree.worktreePath;
    const abandoned = await request(app).post(`/api/tasks/${id1}/worktree/abandon`).send({});
    expect(abandoned.body.status).toBe('abandoned');
    expect(existsSync(wt1)).toBe(false);
    // A fresh worktree can be created again after abandoning.
    const recreated = await request(app).post(`/api/tasks/${id1}/worktree`).send({});
    expect(recreated.status).toBe(201);

    // Preserve path.
    const id2 = await makeApprovedTask();
    await request(app).post(`/api/tasks/${id2}/approve-brief`).send({});
    const wt2 = (await request(app).get(`/api/tasks/${id2}`)).body.worktree.worktreePath;
    const preserved = await request(app).post(`/api/tasks/${id2}/worktree/preserve`).send({});
    expect(preserved.body.status).toBe('preserved');
    expect(existsSync(wt2)).toBe(true);
  });
});

describe('validation scopes pytest to the task-changed test files (real git)', () => {
  /** Like makeApprovedTask but with a pytest test command so scoping applies. */
  async function makePytestTask() {
    const p = await request(app).post('/api/projects').send({
      name: 'Pytest Proj',
      repoPath: repo,
      defaultBranch: 'main',
      agentRuntime: 'claude',
      testCommand: 'pytest -m unit',
    });
    const t = await request(app)
      .post('/api/tasks')
      .send({ projectId: p.body.id, title: 'Fix Thing', rawRequest: 'r' });
    await request(app).post(`/api/tasks/${t.body.id}/generate-brief`).send({});
    return t.body.id as string;
  }

  it('runs only the changed test file, not the whole suite', async () => {
    const id = await makePytestTask();
    // Brief approval creates the worktree (and auto-advances to the plan gate).
    await request(app).post(`/api/tasks/${id}/approve-brief`).send({});
    const wt = (await request(app).get(`/api/tasks/${id}`)).body.worktree.worktreePath;

    // Simulate the agent's edit: a touched test file + a touched source file. Only
    // the test file should scope the run; the source file must not.
    writeFileSync(join(wt, 'test_thing.py'), 'def test_x():\n    assert True\n');
    writeFileSync(join(wt, 'thing.py'), 'x = 1\n');

    // Plan approval auto-advances Implementation -> Validation.
    await request(app).post(`/api/tasks/${id}/approve-plan`).send({});

    const detail = await request(app).get(`/api/tasks/${id}`);
    const commands = detail.body.validationRuns.map((r: { command: string }) => r.command);
    // The recorded test command is scoped to the changed TEST file only.
    expect(commands).toContain("pytest -m unit 'test_thing.py'");
    // It must NOT be the bare whole-repo command, and must NOT include the source file.
    expect(commands).not.toContain('pytest -m unit');
    expect(
      commands.some((c: string) => c.includes('thing.py') && !c.includes('test_thing.py')),
    ).toBe(false);
  });
});
