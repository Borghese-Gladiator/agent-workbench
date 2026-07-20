import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from './migrator.js';
import { Store } from './store.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-migrate-'));
  dbPath = join(dir, 'workbench.sqlite');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const columns = (db: BetterSqlite3.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
const ledger = (db: BetterSqlite3.Database): string[] =>
  (db.prepare('SELECT name FROM kysely_migration ORDER BY name').all() as { name: string }[]).map(
    (r) => r.name,
  );
const hasTable = (db: BetterSqlite3.Database, table: string): boolean =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) !==
  undefined;

const ALL_MIGRATIONS = [
  '0001_init',
  '0002_add_agent_runtime',
  '0003_rename_workspace_to_worktree',
  '0004_agent_runs',
  '0005_add_project_description',
  '0006_delivery_pr_url',
  '0007_task_worktree_mode',
  '0008_agent_run_session_id',
  '0009_agent_run_token_usage',
  '0010_rename_validation_demo_to_verification',
  '0011_agent_run_events_received_at',
  '0012_agent_run_latency',
  '0013_tasks_rev',
  '0014_agent_run_pgid',
  '0015_task_queue',
  '0016_split_verification_into_static_and_e2e',
  '0017_add_project_runtime_config',
  '0018_queue_dependencies',
  '0019_add_project_external_tools',
];

describe('migrator', () => {
  it('brings a fresh database fully up to date', () => {
    const db = new BetterSqlite3(dbPath);
    const applied = migrateToLatest(db);
    expect(applied).toEqual(ALL_MIGRATIONS);
    expect(ledger(db)).toEqual(ALL_MIGRATIONS);
    // 0002 added agent_runtime; 0003 renamed workspaces -> worktrees and the
    // tasks FK column; 0007 added worktree_mode.
    expect(columns(db, 'projects')).toContain('agent_runtime');
    expect(hasTable(db, 'worktrees')).toBe(true);
    expect(hasTable(db, 'workspaces')).toBe(false);
    expect(columns(db, 'tasks')).toContain('worktree_id');
    expect(columns(db, 'tasks')).not.toContain('workspace_id');
    expect(columns(db, 'tasks')).toContain('worktree_mode');
    // 0016 added the feature-E2E skip flag.
    expect(columns(db, 'tasks')).toContain('skip_e2e');
    // 0011 added the dual timestamp on agent_run_events.
    expect(columns(db, 'agent_run_events')).toContain('received_at');
    // 0012 added run-level latency columns on agent_runs.
    expect(columns(db, 'agent_runs')).toContain('duration_api_ms');
    expect(columns(db, 'agent_runs')).toContain('ttft_ms');
    db.close();
  });

  it('is idempotent — a second run applies nothing and does not throw', () => {
    const db = new BetterSqlite3(dbPath);
    migrateToLatest(db);
    const second = migrateToLatest(db);
    expect(second).toEqual([]);
    expect(ledger(db)).toEqual(ALL_MIGRATIONS);
    db.close();
  });

  it('0018 backfills a legacy depends_on_id column into queue_dependencies', () => {
    // Seed a DB that has run everything through 0015 (task_queue with the old
    // single depends_on_id column) but NOT 0018, holding one dependency edge.
    const seed = new BetterSqlite3(dbPath);
    migrateToLatest(seed); // fully migrate to create the tables...
    seed.exec(`DELETE FROM kysely_migration WHERE name = '0018_queue_dependencies'`);
    seed.exec(`DROP TABLE queue_dependencies`);
    seed
      .prepare(`INSERT INTO projects (id, name, repo_path, default_branch, created_at)
        VALUES ('p','P','/tmp/r','main','2026-01-01T00:00:00Z')`)
      .run();
    seed
      .prepare(`INSERT INTO tasks (id, project_id, title, raw_request, stage, status, created_at, updated_at)
        VALUES ('t1','p','A','r','intake','active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
               ('t2','p','B','r','intake','active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`)
      .run();
    seed
      .prepare(`INSERT INTO task_queue (id, task_id, status, priority, depends_on_id, enqueued_at)
        VALUES ('qa','t1','queued',0,NULL,'2026-01-01T00:00:00Z'),
               ('qb','t2','queued',0,'qa','2026-01-01T00:00:00Z')`)
      .run();
    seed.close();

    const db = new BetterSqlite3(dbPath);
    const applied = migrateToLatest(db);
    expect(applied).toEqual(['0018_queue_dependencies']);
    const edges = db.prepare('SELECT queue_id, depends_on_id FROM queue_dependencies').all() as {
      queue_id: string;
      depends_on_id: string;
    }[];
    expect(edges).toEqual([{ queue_id: 'qb', depends_on_id: 'qa' }]);
    db.close();
  });

  it('upgrades an old pre-agent_runtime, pre-rename database', () => {
    // Simulate an OLD install: projects without agent_runtime, the original
    // `workspaces` table + `tasks.workspace_id` column (before the worktree
    // rename), and a ledger that only recorded 0001_init.
    const seed = new BetterSqlite3(dbPath);
    seed.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        delivery_policy TEXT NOT NULL DEFAULT '',
        test_command TEXT NOT NULL DEFAULT '',
        lint_command TEXT NOT NULL DEFAULT '',
        typecheck_command TEXT NOT NULL DEFAULT '',
        e2e_command TEXT NOT NULL DEFAULT '',
        dev_command TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
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
    expect(columns(seed, 'projects')).not.toContain('agent_runtime');
    expect(hasTable(seed, 'workspaces')).toBe(true);
    expect(columns(seed, 'tasks')).toContain('workspace_id');
    seed.close();

    // Opening a Store runs the migrator: 0002 + 0003 apply.
    const store = new Store({ dbPath, artifactsDir: dir });
    const db = new BetterSqlite3(dbPath, { readonly: true });
    expect(ledger(db)).toEqual(ALL_MIGRATIONS);
    expect(hasTable(db, 'worktrees')).toBe(true);
    expect(hasTable(db, 'workspaces')).toBe(false);
    expect(columns(db, 'tasks')).toContain('worktree_id');
    expect(columns(db, 'tasks')).not.toContain('workspace_id');
    db.close();

    // The previously-failing flow now succeeds and round-trips 'claude'.
    const created = store.createProject({
      name: 'Sheng Ji browser',
      repoPath: '/tmp/shengji',
      defaultBranch: 'main',
      agentRuntime: 'claude',
    });
    expect(created.agentRuntime).toBe('claude');
    expect(store.getProject(created.id)?.agentRuntime).toBe('claude');

    // The pre-existing legacy row survived and was backfilled to the default.
    const legacy = store.getProject('prj_old');
    expect(legacy?.name).toBe('Legacy');
    expect(legacy?.agentRuntime).toBe('mock');

    // The renamed worktrees table is usable through the store.
    const task = store.createTask({ projectId: created.id, title: 't', rawRequest: 'r' });
    const wt = store.createWorktree({
      taskId: task.id,
      worktreePath: '/data/worktrees/x',
      branch: 'wb/x',
      baseBranch: 'main',
      status: 'created',
    });
    expect(store.getActiveWorktree(task.id)?.id).toBe(wt.id);
    store.close();
  });

  it('0010 rewrites validation_demo -> verification across all three stage columns', () => {
    // Seed a DB at 0009 (every migration except 0010 recorded) carrying tasks/
    // stage_runs/agent_runs that reference the OLD stage id `validation_demo`,
    // plus a `discovery` row that must be LEFT ALONE.
    const seed = new BetterSqlite3(dbPath);
    seed.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, stage TEXT NOT NULL);
      CREATE TABLE stage_runs (id TEXT PRIMARY KEY, stage TEXT NOT NULL);
      CREATE TABLE agent_runs (id TEXT PRIMARY KEY, stage TEXT NOT NULL);
      CREATE TABLE kysely_migration (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL);
      INSERT INTO tasks (id,stage) VALUES ('t1','validation_demo'), ('t2','discovery');
      INSERT INTO stage_runs (id,stage) VALUES ('s1','validation_demo'), ('s2','discovery');
      INSERT INTO agent_runs (id,stage) VALUES ('a1','validation_demo');
    `);
    for (const m of ALL_MIGRATIONS.filter(
      (n) => n !== '0010_rename_validation_demo_to_verification',
    )) {
      seed
        .prepare(`INSERT INTO kysely_migration (name, executed_at) VALUES (?, ?)`)
        .run(m, '2020-01-01T00:00:00.000Z');
    }
    seed.close();

    const db = new BetterSqlite3(dbPath);
    const applied = migrateToLatest(db);
    expect(applied).toEqual(['0010_rename_validation_demo_to_verification']);

    const stages = (table: string) =>
      (db.prepare(`SELECT stage FROM ${table} ORDER BY id`).all() as { stage: string }[]).map(
        (r) => r.stage,
      );
    expect(stages('tasks')).toEqual(['verification', 'discovery']);
    expect(stages('stage_runs')).toEqual(['verification', 'discovery']);
    expect(stages('agent_runs')).toEqual(['verification']);
    db.close();
  });
});
