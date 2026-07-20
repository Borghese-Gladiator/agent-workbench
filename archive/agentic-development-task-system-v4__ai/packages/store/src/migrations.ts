import type BetterSqlite3 from 'better-sqlite3';

/**
 * Ordered, named schema migrations. The migrator runs any whose `name` is not
 * yet recorded in `kysely_migration`, in array order, each in a transaction.
 *
 * `up` receives the raw better-sqlite3 connection and runs synchronously — the
 * whole Store is constructed synchronously, so migrations must be too. SQL is
 * written directly here (these are plain DDL statements); Kysely owns the typed
 * *querying* in store.ts, not the DDL.
 */
export interface Migration {
  name: string;
  up: (db: BetterSqlite3.Database) => void;
}

/** Whether `table` already has `column` (used to keep ALTERs idempotent). */
function hasColumn(db: BetterSqlite3.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/** Whether `table` exists (used to keep table renames idempotent). */
function hasTable(db: BetterSqlite3.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return row !== undefined;
}

export const MIGRATIONS: Migration[] = [
  {
    // The full schema. Note: `projects` does NOT include agent_runtime here —
    // that column is introduced by 0002 so that a database created by an older
    // build of 0001 (which never had the column) upgrades through the same path
    // as a brand-new database. A brand-new DB runs 0001 then 0002 in one go.
    name: '0001_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
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

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          raw_request TEXT NOT NULL,
          stage TEXT NOT NULL,
          status TEXT NOT NULL,
          workspace_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS stage_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          stage TEXT NOT NULL,
          status TEXT NOT NULL,
          entered_at TEXT NOT NULL,
          completed_at TEXT,
          note TEXT
        );

        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          stage_run_id TEXT REFERENCES stage_runs(id),
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          body_path TEXT NOT NULL,
          byte_size INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          gate TEXT NOT NULL,
          decision TEXT NOT NULL,
          comment TEXT,
          decided_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          worktree_path TEXT NOT NULL,
          branch TEXT NOT NULL,
          base_branch TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          finished_at TEXT
        );

        CREATE TABLE IF NOT EXISTS validation_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          command TEXT NOT NULL,
          status TEXT NOT NULL,
          artifact_id TEXT REFERENCES artifacts(id),
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS delivery_packages (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          artifact_id TEXT REFERENCES artifacts(id),
          target TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_stage_runs_task ON stage_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
        CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
      `);
    },
  },
  {
    // Adds the project agent-runtime selector. Guarded so it is a no-op on a
    // database that somehow already has the column (defensive — the migration
    // ledger normally prevents a re-run).
    name: '0002_add_agent_runtime',
    up: (db) => {
      if (!hasColumn(db, 'projects', 'agent_runtime')) {
        db.exec(`ALTER TABLE projects ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'mock'`);
      }
    },
  },
  {
    // Renames the "workspace" concept to "worktree" throughout: the `workspaces`
    // table -> `worktrees`, and the `tasks.workspace_id` FK -> `worktree_id`.
    // (The on-disk column `worktree_path` already used that name, so only the
    // table name and the tasks FK column change here.) Guarded so it is a no-op
    // on a database that has already been renamed.
    name: '0003_rename_workspace_to_worktree',
    up: (db) => {
      if (hasTable(db, 'workspaces') && !hasTable(db, 'worktrees')) {
        db.exec(`ALTER TABLE workspaces RENAME TO worktrees`);
      }
      if (hasColumn(db, 'tasks', 'workspace_id') && !hasColumn(db, 'tasks', 'worktree_id')) {
        db.exec(`ALTER TABLE tasks RENAME COLUMN workspace_id TO worktree_id`);
      }
    },
  },
  {
    // Agent runs become a first-class, observable entity: a run row plus an
    // append-only event log (streamed from the CLI), plus the structured
    // questions a run raises mid-flight (the interactive gate). A run does NOT
    // advance the lifecycle — it only produces artifacts + events.
    name: '0004_agent_runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          stage TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          total_cost_usd REAL,
          num_turns INTEGER,
          error TEXT
        );

        CREATE TABLE IF NOT EXISTS agent_run_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES agent_runs(id),
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT,
          body_path TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_questions (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES agent_runs(id),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          header TEXT NOT NULL,
          question TEXT NOT NULL,
          options_json TEXT,
          multi_select INTEGER NOT NULL DEFAULT 0,
          permission_json TEXT,
          answer_json TEXT,
          asked_at TEXT NOT NULL,
          answered_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_events_run_seq
          ON agent_run_events(run_id, seq);
        CREATE INDEX IF NOT EXISTS idx_agent_questions_run ON agent_questions(run_id);
        CREATE INDEX IF NOT EXISTS idx_agent_questions_task ON agent_questions(task_id);
      `);
    },
  },
  {
    // Adds a free-form project description. Guarded so it is a no-op on a
    // database that somehow already has the column.
    name: '0005_add_project_description',
    up: (db) => {
      if (!hasColumn(db, 'projects', 'description')) {
        db.exec(`ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    // Delivery becomes real: record the PR URL and a human-readable summary on
    // the delivery package so the published result (or failure) is observable.
    // Guarded so it is a no-op on a database that already has the columns.
    name: '0006_delivery_pr_url',
    up: (db) => {
      // An old install that recorded 0001 before delivery_packages existed in
      // that build won't have the table; 0001's CREATE is skipped by the ledger,
      // so guard on the table too. Create it if missing, then add the columns.
      if (!hasTable(db, 'delivery_packages')) {
        db.exec(`
          CREATE TABLE delivery_packages (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id),
            artifact_id TEXT REFERENCES artifacts(id),
            target TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
        `);
      }
      if (!hasColumn(db, 'delivery_packages', 'pr_url')) {
        db.exec(`ALTER TABLE delivery_packages ADD COLUMN pr_url TEXT`);
      }
      if (!hasColumn(db, 'delivery_packages', 'summary')) {
        db.exec(`ALTER TABLE delivery_packages ADD COLUMN summary TEXT`);
      }
    },
  },
  {
    // Adds worktree_mode to tasks: 'worktree' (default, isolated branch) vs
    // 'direct' (commits land on the project's defaultBranch). Existing tasks
    // default to 'worktree' so the existing behaviour is preserved.
    name: '0007_task_worktree_mode',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'worktree_mode')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN worktree_mode TEXT NOT NULL DEFAULT 'worktree'`);
      }
    },
  },
  {
    // Records the Claude CLI session id on an agent run so a later run can
    // `--resume` it (e.g. a brief rejection resumes the brief's session and
    // sends only the reviewer's comment). Null for mock/legacy runs. Guarded so
    // it is a no-op on a database that already has the column.
    name: '0008_agent_run_session_id',
    up: (db) => {
      if (!hasColumn(db, 'agent_runs', 'session_id')) {
        db.exec(`ALTER TABLE agent_runs ADD COLUMN session_id TEXT`);
      }
    },
  },
  {
    // Captures the per-run token breakdown from the CLI's `result.usage` object
    // (input / output / cache-creation / cache-read), alongside the existing
    // total_cost_usd. cache_read is the spend lever on resumed sessions. Null
    // for mock/legacy runs. Each ALTER guarded so it is a no-op on a database
    // that already has the column.
    name: '0009_agent_run_token_usage',
    up: (db) => {
      if (!hasColumn(db, 'agent_runs', 'input_tokens')) {
        db.exec(`ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER`);
      }
      if (!hasColumn(db, 'agent_runs', 'output_tokens')) {
        db.exec(`ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER`);
      }
      if (!hasColumn(db, 'agent_runs', 'cache_creation_input_tokens')) {
        db.exec(`ALTER TABLE agent_runs ADD COLUMN cache_creation_input_tokens INTEGER`);
      }
      if (!hasColumn(db, 'agent_runs', 'cache_read_input_tokens')) {
        db.exec(`ALTER TABLE agent_runs ADD COLUMN cache_read_input_tokens INTEGER`);
      }
    },
  },
  {
    // Renames the `validation_demo` lifecycle stage id -> `verification` to match
    // what the stage actually does (there is no "demo"; the display label was
    // already "Verification"). Stage ids are persisted in three columns:
    // tasks.stage, stage_runs.stage, and agent_runs.stage. Rewrite all three.
    // Idempotent: a re-run just matches zero old-name rows. Artifact KINDS and
    // approval GATES are a separate namespace and are intentionally untouched.
    name: '0010_rename_validation_demo_to_verification',
    up: (db) => {
      for (const table of ['tasks', 'stage_runs', 'agent_runs']) {
        if (!hasTable(db, table)) continue;
        db.prepare(
          `UPDATE ${table} SET stage = 'verification' WHERE stage = 'validation_demo'`,
        ).run();
      }
    },
  },
  {
    // Dual timestamp on agent_run_events: `received_at` is stamped when the
    // daemon receives the parsed stream line (before the SQLite insert), next to
    // the existing `created_at` (insert time). Their divergence isolates
    // daemon-side persist delay from model-side latency — load-bearing for the
    // per-turn TTFT investigation. Nullable; legacy rows stay null. Guarded so
    // it is a no-op on a database that already has the column.
    name: '0011_agent_run_events_received_at',
    up: (db) => {
      // Guard on the table: a seed/old install whose ledger predates the
      // agent_run_events table (0004) won't have it yet. (Matches 0006's guard.)
      if (hasTable(db, 'agent_run_events') && !hasColumn(db, 'agent_run_events', 'received_at')) {
        db.exec(`ALTER TABLE agent_run_events ADD COLUMN received_at TEXT`);
      }
    },
  },
  {
    // Latency on the agent_runs row: `duration_api_ms` (true model-API latency
    // from the CLI `result` line) and `ttft_ms` (the run's first-turn
    // time-to-first-token). Previously these lived only on the streamed `cost`/
    // `turn` events and vanished on reload; persisting them makes run latency
    // queryable/sortable without replaying the event stream. Nullable; legacy
    // and mock runs stay null. Each ALTER guarded for idempotency.
    name: '0012_agent_run_latency',
    up: (db) => {
      if (!hasColumn(db, 'agent_runs', 'duration_api_ms')) {
        db.exec(`ALTER TABLE agent_runs ADD COLUMN duration_api_ms INTEGER`);
      }
      if (!hasColumn(db, 'agent_runs', 'ttft_ms')) {
        db.exec(`ALTER TABLE agent_runs ADD COLUMN ttft_ms INTEGER`);
      }
    },
  },
  {
    // Optimistic-locking revision counter. Every task UPDATE bumps `rev` and is
    // guarded on the rev it read, so a stale read-modify-write loses (0 rows
    // affected -> StaleWriteError) instead of silently clobbering a concurrent
    // mutation. Existing rows default to 0. Guarded for idempotent re-runs.
    name: '0013_tasks_rev',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'rev')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    // Process-group id of the spawned CLI, recorded at spawn so a later daemon
    // boot can reap an orphaned process group (the claude process + its child
    // MCP ask-server share this group). Nullable: mock runs spawn nothing, and
    // legacy/old rows never captured it. Guarded for idempotent re-runs.
    name: '0014_agent_run_pgid',
    up: (db) => {
      if (hasTable(db, 'agent_runs') && !hasColumn(db, 'agent_runs', 'pgid')) {
        db.exec(`ALTER TABLE agent_runs ADD COLUMN pgid INTEGER`);
      }
    },
  },
  {
    // Multi-task queue: one row per enqueued task. The scheduler drives `queued`
    // entries whose `depends_on_id` predecessor (another queue row) has reached
    // `done`, ordered by priority desc then enqueued_at asc (FIFO). `depends_on_id`
    // is a soft self-FK (no ON DELETE behaviour — abandoning a task is handled in
    // app code). One queue entry per task is enforced by a unique index so a task
    // can't be enqueued twice.
    name: '0015_task_queue',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_queue (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          status TEXT NOT NULL DEFAULT 'queued',
          priority INTEGER NOT NULL DEFAULT 0,
          depends_on_id TEXT REFERENCES task_queue(id),
          enqueued_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_queue_task ON task_queue(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
        CREATE INDEX IF NOT EXISTS idx_task_queue_depends ON task_queue(depends_on_id);
      `);
    },
  },
  {
    // Split the single `verification` stage into `static_checks` (shell
    // typecheck/test/lint gate) + `feature_e2e` (agent-authored E2E, gated on the
    // harness verdict). Both roll up to "Verification" in the UI.
    //
    // (a) Add tasks.skip_e2e — the human's opt-out of feature_e2e at the plan
    //     gate. 0/1, default 0 (do not skip).
    // (b) Rewrite persisted stage ids: existing `verification` rows become
    //     `static_checks` (the half that always runs), mirroring the 0010 rename
    //     across tasks.stage / stage_runs.stage / agent_runs.stage. Historical
    //     tasks get no `feature_e2e` row — there is nothing to backfill. Idempotent.
    name: '0016_split_verification_into_static_and_e2e',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'skip_e2e')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN skip_e2e INTEGER NOT NULL DEFAULT 0`);
      }
      for (const table of ['tasks', 'stage_runs', 'agent_runs']) {
        if (!hasTable(db, table)) continue;
        db.prepare(
          `UPDATE ${table} SET stage = 'static_checks' WHERE stage = 'verification'`,
        ).run();
      }
    },
  },
  {
    // Per-project runtime config (model/baseUrl/binary), stored as a JSON string.
    // Nullable: existing projects and the mock runtime carry no config.
    name: '0017_add_project_runtime_config',
    up: (db) => {
      if (!hasColumn(db, 'projects', 'runtime_config_json')) {
        db.exec(`ALTER TABLE projects ADD COLUMN runtime_config_json TEXT`);
      }
    },
  },
  {
    // Queue dependencies as edges. One row per directed edge in the queue DAG:
    // `queue_id` cannot run until `depends_on_id`'s task reaches `done`. Storing
    // edges as rows (rather than a single depends_on_id column) lets an entry
    // wait on many predecessors — chains, fan-out, fan-in, arbitrary DAGs.
    //
    // The legacy `task_queue.depends_on_id` column is backfilled into this table
    // and then left in place (unread) — dropping a column in SQLite needs a full
    // table rebuild, not worth it for a nullable stub.
    name: '0018_queue_dependencies',
    up: (db) => {
      if (!hasTable(db, 'queue_dependencies')) {
        db.exec(`
          CREATE TABLE queue_dependencies (
            queue_id TEXT NOT NULL REFERENCES task_queue(id) ON DELETE CASCADE,
            depends_on_id TEXT NOT NULL REFERENCES task_queue(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (queue_id, depends_on_id),
            CHECK (queue_id <> depends_on_id)
          );

          CREATE INDEX IF NOT EXISTS idx_queue_deps_depends_on
            ON queue_dependencies(depends_on_id);
        `);
      }
      db.exec(`
        INSERT OR IGNORE INTO queue_dependencies (queue_id, depends_on_id, created_at)
        SELECT id, depends_on_id, enqueued_at
        FROM task_queue
        WHERE depends_on_id IS NOT NULL;
      `);
    },
  },
  {
    // External helper tools (ExternalToolConfig[]) a project's stage agents may
    // use, stored as a JSON string. Nullable: most projects carry none.
    name: '0019_add_project_external_tools',
    up: (db) => {
      if (!hasColumn(db, 'projects', 'external_tools_json')) {
        db.exec(`ALTER TABLE projects ADD COLUMN external_tools_json TEXT`);
      }
    },
  },
];
