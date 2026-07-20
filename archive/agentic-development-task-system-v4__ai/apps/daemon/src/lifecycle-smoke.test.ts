/**
 * Tier-3 API smoke: the authoritative, in-process lifecycle test.
 *
 * Drives the full task lifecycle over the real HTTP surface (supertest, no
 * subprocess/port) against a real git repo + GitWorktreeProvider. This
 * consolidates what the root-level manual_test_*.py scripts proved over a live
 * daemon, minus the live-`claude` gate (that stays a Tier-5 proof run):
 *   - autoadvance: 4 gates only; removed non-gate routes 404; main checkout clean.
 *   - store_migration: an old on-disk DB upgrades and the agentRuntime=claude
 *     create flow works at the HTTP layer, with the legacy row backfilled.
 *
 * Question-gate and log-attribution behavior is covered by agent-stream.test.ts,
 * agent.test.ts, and app.test.ts; this file does not duplicate them.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitDeliveryAdapter } from '@workbench/delivery';
import { Store } from '@workbench/store';
import { GitWorktreeProvider } from '@workbench/worktree';
import BetterSqlite3 from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

let store: Store;
let artifactsDir: string;
let worktreesDir: string;
let repo: string;
let app: ReturnType<typeof createApp>;

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-smoke-repo-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# example\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');
  return dir;
}

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'wb-smoke-art-'));
  worktreesDir = mkdtempSync(join(tmpdir(), 'wb-smoke-wt-'));
  repo = makeGitRepo();
  store = new Store({ dbPath: ':memory:', artifactsDir });
  // Dry-run delivery: this test asserts the lifecycle reaches closeout and that
  // the main checkout stays clean (work lives in a worktree). A real squash-merge
  // would mutate the main checkout and try to push to a non-existent remote; the
  // real publish path is covered by @workbench/delivery's unit tests.
  app = createApp(store, {
    worktrees: new GitWorktreeProvider(),
    worktreesDir,
    delivery: new GitDeliveryAdapter({ dryRun: true }),
  });
});
afterEach(() => {
  store.close();
  for (const d of [artifactsDir, worktreesDir, repo]) rmSync(d, { recursive: true, force: true });
});

// Real-git, full-lifecycle walk: many gates + worktree create/remove + subprocess
// spawns, so it legitimately exceeds a unit test's budget and must not race
// vitest's 5s default under parallel-worker CPU pressure. 30s headroom.
describe('Tier-3 lifecycle smoke (real git, in-process)', { timeout: 30_000 }, () => {
  it('walks intake -> closeout through the 4 gates, leaving the main checkout clean', async () => {
    const p = await request(app)
      .post('/api/projects')
      .send({ name: 'P', repoPath: repo, defaultBranch: 'main' });
    const t = await request(app)
      .post('/api/tasks')
      .send({ projectId: p.body.id, title: 'Add Dark Mode', rawRequest: 'toggle' });
    const id = t.body.id as string;

    const step = async (path: string) => {
      const res = await request(app).post(`/api/tasks/${id}/${path}`).send({});
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
      return res.body;
    };

    expect((await step('generate-brief')).stage).toBe('human_brief_approval');
    expect((await step('approve-brief')).stage).toBe('human_plan_approval');
    expect((await step('approve-plan')).stage).toBe('human_review');
    expect((await step('review/complete')).stage).toBe('human_delivery_approval');
    const closed = await step('approve-delivery');
    expect(closed.stage).toBe('closeout');
    expect(closed.status).toBe('done');

    // Driver produced every non-gate artifact internally.
    const detail = await request(app).get(`/api/tasks/${id}`);
    const kinds = new Set(detail.body.artifacts.map((a: { kind: string }) => a.kind));
    // NOTE: baseline_evidence is intentionally absent — it is captured only when
    // Verification hits a post-change failure to adjudicate; this green walk never
    // produces one. There is also no standalone `discovery` artifact: discovery
    // and planning are one stage that emits a single `execution_plan`.
    for (const k of ['execution_plan', 'validation_report', 'delivery_package']) {
      expect(kinds, `missing ${k}`).toContain(k);
    }

    // The project's main checkout must be untouched (work happened in a worktree).
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('exposes ONLY the gate routes — removed non-gate routes 404', async () => {
    const p = await request(app)
      .post('/api/projects')
      .send({ name: 'P', repoPath: repo, defaultBranch: 'main' });
    const t = await request(app)
      .post('/api/tasks')
      .send({ projectId: p.body.id, title: 'T', rawRequest: 'r' });
    const id = t.body.id as string;

    for (const route of [
      'discovery',
      'baseline-evidence',
      'execution-plan',
      'complete-implementation',
      'validation-demo',
      'self-review',
      'delivery-prep',
      'closeout',
    ]) {
      const res = await request(app).post(`/api/tasks/${id}/${route}`).send({});
      expect(res.status, `route ${route} should be removed`).toBe(404);
    }
  });

  it('boots on an old on-disk DB: agentRuntime=claude create works, legacy row backfilled', async () => {
    // Seed an OLD-schema DB (projects without agent_runtime) + a ledger that
    // only recorded 0001_init — the exact shape an old install left behind.
    const dataDir = mkdtempSync(join(tmpdir(), 'wb-smoke-olddb-'));
    const dbPath = join(dataDir, 'workbench.sqlite');
    const seed = new BetterSqlite3(dbPath);
    seed.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
        default_branch TEXT NOT NULL, delivery_policy TEXT NOT NULL DEFAULT '',
        test_command TEXT NOT NULL DEFAULT '', lint_command TEXT NOT NULL DEFAULT '',
        typecheck_command TEXT NOT NULL DEFAULT '', e2e_command TEXT NOT NULL DEFAULT '',
        dev_command TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        raw_request TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
        workspace_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worktree_path TEXT NOT NULL,
        branch TEXT NOT NULL, base_branch TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE stage_runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT NOT NULL,
        status TEXT NOT NULL, entered_at TEXT NOT NULL, completed_at TEXT, note TEXT
      );
      CREATE TABLE kysely_migration (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL);
      INSERT INTO kysely_migration (name, executed_at) VALUES ('0001_init', '2020-01-01T00:00:00.000Z');
      INSERT INTO projects (id,name,repo_path,default_branch,created_at)
        VALUES ('prj_old','Legacy','/tmp/legacy','main','2020-01-01T00:00:00.000Z');
    `);
    seed.close();

    // Opening a Store runs the migrator (the daemon does this at boot).
    const upgraded = new Store({ dbPath, artifactsDir: dataDir });
    const oldDbApp = createApp(upgraded);
    try {
      // The exact flow that used to 500 with "no column named agent_runtime".
      const created = await request(oldDbApp)
        .post('/api/projects')
        // A 'claude' project's repoPath must exist (validated on create); this
        // test only exercises the create/migration path, so any real dir works.
        .send({
          name: 'Sheng Ji',
          repoPath: dataDir,
          defaultBranch: 'main',
          agentRuntime: 'claude',
        });
      expect(created.status).toBe(201);
      expect(created.body.agentRuntime).toBe('claude');

      const list = await request(oldDbApp).get('/api/projects');
      const byId = Object.fromEntries(list.body.map((pr: { id: string }) => [pr.id, pr]));
      expect(byId[created.body.id].agentRuntime).toBe('claude');
      // Legacy row survived and backfilled to the default runtime.
      expect(byId['prj_old']?.name).toBe('Legacy');
      expect(byId['prj_old']?.agentRuntime).toBe('mock');
    } finally {
      upgraded.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
