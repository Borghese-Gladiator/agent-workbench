import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  AgentQuestion,
  AgentQuestionAnswer,
  AgentQuestionOption,
  AgentRun,
  AgentRunEvent,
  AgentRunEventType,
  AgentRunStatus,
  AgentRuntime,
  Approval,
  Artifact,
  ArtifactKind,
  DeliveryPackage,
  DeliveryPolicy,
  ExternalToolConfig,
  Job,
  Project,
  QueueEntry,
  QueueEntryStatus,
  RuntimeConfig,
  Stage,
  StageRun,
  Task,
  TaskStatus,
  ValidationRun,
  Worktree,
} from '@workbench/core';
import { normalizeDeliveryPolicy } from '@workbench/core';
import BetterSqlite3 from 'better-sqlite3';
import { CamelCasePlugin, type Compilable, Kysely, SqliteDialect, sql } from 'kysely';
import { nanoid } from 'nanoid';
import { ArtifactFileStore } from './artifact-files.js';
import { migrateToLatest } from './migrator.js';
import { ProjectMemoryStore } from './project-memory-files.js';
import type { Database, ProjectsTable } from './schema-types.js';

/** A raw projects row as stored (camelCased by Kysely), before hydration. */
type ProjectRow = ProjectsTable;

/**
 * Thrown when a guarded task UPDATE affects 0 rows because the `rev` it read no
 * longer matches the row — i.e. another writer mutated the task in between. The
 * caller lost an optimistic-lock race; the HTTP edge maps this to 409 so the
 * loser retries against fresh state instead of silently clobbering the winner.
 */
export class StaleWriteError extends Error {
  constructor(public readonly taskId: string) {
    super(`task ${taskId} was modified concurrently (stale write rejected)`);
    this.name = 'StaleWriteError';
  }
}

export interface StoreOptions {
  /** Path to the SQLite file. ':memory:' for tests. */
  dbPath: string;
  /** Directory where artifact bodies are written. */
  artifactsDir: string;
  /**
   * Directory holding per-project memory files (`<projectId>.md`). Defaults to a
   * `project-memory` sibling of `artifactsDir` when omitted, so existing callers
   * (and tests) don't have to thread it.
   */
  projectMemoryDir?: string;
}

const now = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}_${nanoid(10)}`;

/** Parse the stored `runtimeConfigJson` column into a {@link RuntimeConfig}. */
function parseRuntimeConfig(json: string | null | undefined): RuntimeConfig {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as RuntimeConfig;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Parse the stored `externalToolsJson` column into an {@link ExternalToolConfig} list. */
function parseExternalTools(json: string | null | undefined): ExternalToolConfig[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as ExternalToolConfig[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Coerce a raw projects row into a typed Project. `deliveryPolicy` is stored as
 * free-form text (legacy rows predate the typed enum) so it is normalized on
 * read; `runtimeConfig` and `externalTools` are stored as JSON string columns
 * and parsed here.
 */
function hydrateProject(row: ProjectRow): Project {
  const { runtimeConfigJson, externalToolsJson, ...rest } = row;
  return {
    ...rest,
    agentRuntime: rest.agentRuntime as AgentRuntime,
    deliveryPolicy: normalizeDeliveryPolicy(rest.deliveryPolicy),
    runtimeConfig: parseRuntimeConfig(runtimeConfigJson),
    externalTools: parseExternalTools(externalToolsJson),
  };
}

/**
 * SQLite stores booleans as 0/1, so `skip_e2e` comes back as a number. Coerce it
 * to a real boolean so the @workbench/core `Task.skipE2e` contract holds.
 */
function hydrateTask(row: Task): Task {
  return { ...row, skipE2e: Boolean((row as Task & { skipE2e: unknown }).skipE2e) };
}

export interface NewProject {
  name: string;
  description?: string;
  repoPath: string;
  defaultBranch: string;
  agentRuntime?: AgentRuntime;
  runtimeConfig?: RuntimeConfig;
  externalTools?: ExternalToolConfig[];
  deliveryPolicy?: DeliveryPolicy;
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  e2eCommand?: string;
  devCommand?: string;
}

/**
 * The Store owns all persistence. It is the only place the daemon reaches for
 * data. It is a thin typed wrapper over SQLite (via Kysely) + the artifact file
 * store — domain decisions live in @workbench/core, not here.
 *
 * Kysely is configured with CamelCasePlugin, so query inputs/outputs use the
 * camelCase property names of the @workbench/core domain types while the schema
 * (schema-types.ts) and SQL stay snake_case. Selected rows therefore map onto
 * the domain types directly, and a query that names a column the schema doesn't
 * declare is a compile error.
 */
export class Store {
  private readonly sqlite: BetterSqlite3.Database;
  /** Query *builder* only — used to construct typed queries, then compiled. */
  private readonly db: Kysely<Database>;
  /** Same plugin instance the builder uses, kept to camelCase result rows. */
  private readonly camel: CamelCasePlugin;
  readonly files: ArtifactFileStore;
  readonly projectMemory: ProjectMemoryStore;
  /**
   * Observers notified when a task's persisted state changes (transition or new
   * artifact). The store is the single writer, so emitting HERE — at the mutation
   * — makes it impossible to change a task without announcing it. Listeners get
   * only the taskId (a notification, not the new state): consumers refetch the
   * canonical row, so duplicate or out-of-order notifications are harmless. The
   * store knows nothing about who listens (SSE, logging, tests).
   */
  private readonly changeListeners = new Set<(taskId: string) => void>();

  constructor(opts: StoreOptions) {
    if (opts.dbPath !== ':memory:') {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
    }
    this.sqlite = new BetterSqlite3(opts.dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    migrateToLatest(this.sqlite);
    this.camel = new CamelCasePlugin();
    this.db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: this.sqlite }),
      plugins: [this.camel],
    });
    this.files = new ArtifactFileStore(opts.artifactsDir);
    this.projectMemory = new ProjectMemoryStore(
      opts.projectMemoryDir ?? resolve(opts.artifactsDir, '..', 'project-memory'),
    );
  }

  close(): void {
    // Destroying Kysely closes the underlying better-sqlite3 connection.
    void this.db.destroy();
  }

  /**
   * Observe task state changes. The callback fires (with the taskId) after any
   * write that changes a task — a transition or a new artifact — at its commit
   * point. Returns an unsubscribe function. Notification-only by design: the
   * callback should refetch the canonical state, not trust a payload.
   */
  onTaskChange(cb: (taskId: string) => void): () => void {
    this.changeListeners.add(cb);
    return () => {
      this.changeListeners.delete(cb);
    };
  }

  /** Fan out a change notification; one bad listener never breaks a write. */
  private notifyChange(taskId: string): void {
    for (const cb of this.changeListeners) {
      try {
        cb(taskId);
      } catch {
        /* a listener throwing must not corrupt the write that triggered it */
      }
    }
  }

  /*
   * Synchronous execution bridge.
   *
   * Kysely's .execute() is async, but the whole Store is synchronous and
   * better-sqlite3 is a synchronous driver. So we use Kysely purely to build &
   * type-check queries, compile() them (sync; the CamelCasePlugin rewrites
   * identifiers to snake_case here), and run the SQL on better-sqlite3 directly.
   * Result rows come back snake_case, so we map them back with the same plugin's
   * row mapper — exactly what Kysely's async executor would have done.
   */
  private camelRow<T>(row: unknown): T {
    return (this.camel as unknown as { mapRow(r: Record<string, unknown>): T }).mapRow(
      row as Record<string, unknown>,
    );
  }

  private all<T>(query: Compilable<T>): T[] {
    const { sql, parameters } = query.compile();
    const rows = this.sqlite.prepare(sql).all(...(parameters as unknown[]));
    return (rows as unknown[]).map((r) => this.camelRow<T>(r));
  }

  private get<T>(query: Compilable<T>): T | null {
    const { sql, parameters } = query.compile();
    const row = this.sqlite.prepare(sql).get(...(parameters as unknown[]));
    return row === undefined ? null : this.camelRow<T>(row);
  }

  private run<T>(query: Compilable<T>): void {
    const { sql, parameters } = query.compile();
    this.sqlite.prepare(sql).run(...(parameters as unknown[]));
  }

  /** Like `run`, but returns how many rows the statement changed (for guarded UPDATEs). */
  private runChanges<T>(query: Compilable<T>): number {
    const { sql, parameters } = query.compile();
    return this.sqlite.prepare(sql).run(...(parameters as unknown[])).changes;
  }

  /* ---------- Projects ---------- */
  createProject(p: NewProject): Project {
    const runtimeConfig = p.runtimeConfig ?? {};
    const row: ProjectRow = {
      id: id('prj'),
      name: p.name,
      description: p.description ?? '',
      repoPath: p.repoPath,
      defaultBranch: p.defaultBranch,
      agentRuntime: p.agentRuntime ?? 'mock',
      // Stored as a JSON string; null when empty so legacy/mock rows stay clean.
      runtimeConfigJson: Object.keys(runtimeConfig).length ? JSON.stringify(runtimeConfig) : null,
      externalToolsJson: p.externalTools?.length ? JSON.stringify(p.externalTools) : null,
      deliveryPolicy: normalizeDeliveryPolicy(p.deliveryPolicy),
      testCommand: p.testCommand ?? '',
      lintCommand: p.lintCommand ?? '',
      typecheckCommand: p.typecheckCommand ?? '',
      e2eCommand: p.e2eCommand ?? '',
      devCommand: p.devCommand ?? '',
      createdAt: now(),
    };
    this.run(this.db.insertInto('projects').values(row));
    return hydrateProject(row);
  }

  listProjects(): Project[] {
    return (
      this.all(
        this.db.selectFrom('projects').selectAll().orderBy('createdAt'),
      ) as unknown as ProjectRow[]
    ).map(hydrateProject);
  }

  getProject(projectId: string): Project | null {
    const row = this.get(
      this.db.selectFrom('projects').selectAll().where('id', '=', projectId),
    ) as unknown as ProjectRow | null;
    return row === null ? null : hydrateProject(row);
  }

  /** Update a project's delivery policy (e.g. to enforce the enterprise draft-PR rule). */
  setProjectDeliveryPolicy(projectId: string, policy: DeliveryPolicy): void {
    this.run(
      this.db.updateTable('projects').set({ deliveryPolicy: policy }).where('id', '=', projectId),
    );
  }

  /** Update a project's display name (e.g. to enforce a canonical enterprise name). */
  setProjectName(projectId: string, name: string): void {
    this.run(this.db.updateTable('projects').set({ name }).where('id', '=', projectId));
  }

  /** Replace a project's external helper tools (e.g. to enforce the canonical enterprise set). */
  setProjectExternalTools(projectId: string, tools: ExternalToolConfig[]): void {
    this.run(
      this.db
        .updateTable('projects')
        .set({ externalToolsJson: tools.length ? JSON.stringify(tools) : null })
        .where('id', '=', projectId),
    );
  }

  /* ---------- Tasks ---------- */
  createTask(input: {
    projectId: string;
    title: string;
    rawRequest: string;
    worktreeMode?: 'worktree' | 'direct';
  }): Task {
    return this.createTaskRow(input.projectId, input.title, input.rawRequest, input.worktreeMode);
  }

  /**
   * Insert a task row + its opening stage run. NO transaction of its own so it can
   * be composed inside a larger one (createQueueDag creates many tasks + queue
   * entries atomically). Caller owns atomicity.
   */
  private createTaskRow(
    projectId: string,
    title: string,
    rawRequest: string,
    worktreeMode: 'worktree' | 'direct' = 'worktree',
  ): Task {
    const ts = now();
    const row = {
      id: id('task'),
      projectId,
      title,
      rawRequest,
      stage: 'intake' as Stage,
      status: 'active' as TaskStatus,
      worktreeId: null as string | null,
      worktreeMode,
      // SQLite stores booleans as 0/1; persist the integer, hydrate to boolean.
      skipE2e: 0,
      createdAt: ts,
      updatedAt: ts,
      rev: 0,
    };
    this.run(this.db.insertInto('tasks').values(row));
    this.openStageRun(row.id, 'intake', 'task created');
    return hydrateTask(row as unknown as Task);
  }

  listTasks(): Task[] {
    return (
      this.all(
        this.db.selectFrom('tasks').selectAll().orderBy('updatedAt', 'desc'),
      ) as unknown as Task[]
    ).map(hydrateTask);
  }

  getTask(taskId: string): Task | null {
    const row = this.get(
      this.db.selectFrom('tasks').selectAll().where('id', '=', taskId),
    ) as unknown as Task | null;
    return row === null ? null : hydrateTask(row);
  }

  /**
   * Delete a task and all of its child rows. Children reference the task (or its
   * agent runs) via FKs, so they are removed first, deepest-first, in a single
   * transaction. Artifact bodies on disk are left in place (gitignored data dir).
   */
  deleteTask(taskId: string): boolean {
    if (!this.getTask(taskId)) return false;
    const runIds = (
      this.all(
        this.db.selectFrom('agent_runs').select('id').where('taskId', '=', taskId),
      ) as unknown as { id: string }[]
    ).map((r) => r.id);

    const tx = this.sqlite.transaction(() => {
      if (runIds.length > 0) {
        this.run(this.db.deleteFrom('agent_run_events').where('runId', 'in', runIds));
      }
      this.run(this.db.deleteFrom('agent_questions').where('taskId', '=', taskId));
      this.run(this.db.deleteFrom('agent_runs').where('taskId', '=', taskId));
      this.run(this.db.deleteFrom('validation_runs').where('taskId', '=', taskId));
      this.run(this.db.deleteFrom('delivery_packages').where('taskId', '=', taskId));
      this.run(this.db.deleteFrom('jobs').where('taskId', '=', taskId));
      this.run(this.db.deleteFrom('approvals').where('taskId', '=', taskId));
      this.run(this.db.deleteFrom('artifacts').where('taskId', '=', taskId));
      this.run(this.db.deleteFrom('worktrees').where('taskId', '=', taskId));
      this.run(this.db.deleteFrom('stage_runs').where('taskId', '=', taskId));
      this.run(this.db.deleteFrom('tasks').where('id', '=', taskId));
    });
    tx();
    return true;
  }

  /**
   * Applies a stage/status transition: closes the prior stage run, opens a new
   * one, and updates the task row — atomically. The stage-run close/open and the
   * task UPDATE run inside ONE SQLite transaction so a crash mid-transition can't
   * leave `tasks` and `stage_runs` out of sync. The UPDATE is guarded on the
   * `rev` read at entry; if another writer changed the task first, it affects 0
   * rows and the whole transaction rolls back as a `StaleWriteError`.
   */
  applyTransition(taskId: string, next: { stage: Stage; status: TaskStatus; note?: string }): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const ts = now();
    const stageChanged = task.stage !== next.stage;
    const expectedRev = task.rev;

    const tx = this.sqlite.transaction(() => {
      if (stageChanged) {
        this.completeOpenStageRun(taskId, ts);
        this.openStageRun(taskId, next.stage, next.note ?? null, ts);
      } else if (next.note) {
        // Same stage but noteworthy (e.g. abandon) — annotate the open run.
        this.run(
          this.db
            .updateTable('stage_runs')
            .set({ note: next.note })
            .where('taskId', '=', taskId)
            .where('status', '=', 'in_progress'),
        );
      }

      const changed = this.runChanges(
        this.db
          .updateTable('tasks')
          .set({ stage: next.stage, status: next.status, updatedAt: ts, rev: expectedRev + 1 })
          .where('id', '=', taskId)
          .where('rev', '=', expectedRev),
      );
      // 0 rows -> the rev moved under us; throw to roll back the stage-run writes too.
      if (changed === 0) throw new StaleWriteError(taskId);
    });
    tx();

    // Committed and consistent — announce once, then return the fresh row.
    this.notifyChange(taskId);
    return this.getTask(taskId)!;
  }

  /**
   * Rename a task. Called when the brief stage derives a real title for a task
   * whose title was a placeholder (e.g. a bare Linear URL). Runs before the
   * worktree/branch are created, so the new title flows into their naming.
   */
  setTaskTitle(taskId: string, title: string): void {
    this.run(
      this.db.updateTable('tasks').set({ title, updatedAt: now() }).where('id', '=', taskId),
    );
  }

  setWorktreeOnTask(taskId: string, worktreeId: string): void {
    this.run(
      this.db
        .updateTable('tasks')
        .set({ worktreeId, updatedAt: now(), rev: sql`rev + 1` })
        .where('id', '=', taskId),
    );
  }

  setWorktreeModeOnTask(taskId: string, mode: 'worktree' | 'direct'): void {
    this.run(
      this.db
        .updateTable('tasks')
        .set({ worktreeMode: mode, updatedAt: now(), rev: sql`rev + 1` })
        .where('id', '=', taskId),
    );
  }

  setSkipE2eOnTask(taskId: string, skip: boolean): void {
    this.run(
      this.db
        .updateTable('tasks')
        .set({ skipE2e: skip ? 1 : 0, updatedAt: now(), rev: sql`rev + 1` })
        .where('id', '=', taskId),
    );
  }

  /* ---------- Stage runs ---------- */
  private openStageRun(taskId: string, stage: Stage, note: string | null, ts = now()): StageRun {
    const row = {
      id: id('run'),
      taskId,
      stage,
      status: 'in_progress' as StageRun['status'],
      enteredAt: ts,
      completedAt: null as string | null,
      note,
    };
    this.run(this.db.insertInto('stage_runs').values(row));
    return row;
  }

  private completeOpenStageRun(taskId: string, ts = now()): void {
    this.run(
      this.db
        .updateTable('stage_runs')
        .set({ status: 'completed', completedAt: ts })
        .where('taskId', '=', taskId)
        .where('status', '=', 'in_progress'),
    );
  }

  currentStageRun(taskId: string): StageRun | null {
    return this.get(
      this.db
        .selectFrom('stage_runs')
        .selectAll()
        .where('taskId', '=', taskId)
        .where('status', '=', 'in_progress')
        .orderBy('enteredAt', 'desc')
        .limit(1),
    ) as unknown as StageRun | null;
  }

  listStageRuns(taskId: string): StageRun[] {
    return this.all(
      this.db
        .selectFrom('stage_runs')
        .selectAll()
        .where('taskId', '=', taskId)
        .orderBy('enteredAt'),
    ) as unknown as StageRun[];
  }

  /**
   * The stage run for a *specific* stage, regardless of where the task's
   * lifecycle pointer currently sits. Prefers an open (`in_progress`) run, then
   * falls back to the most recent run for that stage. Returns `null` if the task
   * never entered the stage. Used to attribute an agent run's artifacts to the
   * stage the agent actually ran — not whichever stage happens to be open.
   */
  stageRunForStage(taskId: string, stage: Stage): StageRun | null {
    const runs = this.all(
      this.db
        .selectFrom('stage_runs')
        .selectAll()
        .where('taskId', '=', taskId)
        .where('stage', '=', stage)
        .orderBy('enteredAt', 'desc'),
    ) as unknown as StageRun[];
    return runs.find((r) => r.status === 'in_progress') ?? runs[0] ?? null;
  }

  /* ---------- Artifacts ---------- */
  createArtifact(input: {
    taskId: string;
    kind: ArtifactKind;
    title: string;
    body: string;
    stageRunId?: string | null;
  }): Artifact {
    const artifactId = id('art');
    const { relPath, byteSize } = this.files.write(input.taskId, artifactId, input.body);
    const stageRunId =
      input.stageRunId === undefined
        ? (this.currentStageRun(input.taskId)?.id ?? null)
        : input.stageRunId;
    const row = {
      id: artifactId,
      taskId: input.taskId,
      stageRunId,
      kind: input.kind,
      title: input.title,
      bodyPath: relPath,
      byteSize,
      createdAt: now(),
    };
    this.run(this.db.insertInto('artifacts').values(row));
    this.notifyChange(input.taskId);
    return row;
  }

  listArtifacts(taskId: string): Artifact[] {
    return this.all(
      this.db.selectFrom('artifacts').selectAll().where('taskId', '=', taskId).orderBy('createdAt'),
    ) as unknown as Artifact[];
  }

  getArtifact(artifactId: string): Artifact | null {
    return this.get(
      this.db.selectFrom('artifacts').selectAll().where('id', '=', artifactId),
    ) as unknown as Artifact | null;
  }

  readArtifactBody(artifactId: string): string | null {
    const a = this.getArtifact(artifactId);
    return a ? this.files.read(a.bodyPath) : null;
  }

  /** The project's append-only memory log, or '' if it has none yet. */
  readProjectMemory(projectId: string): string {
    return this.projectMemory.read(projectId);
  }

  /** Append one distilled decision entry to the project's memory log. */
  appendProjectMemory(projectId: string, entry: string): void {
    this.projectMemory.append(projectId, entry);
  }

  /**
   * Copy an external proof file (Playwright video/trace from a task worktree)
   * into durable artifact storage. Returns the stored relative path, suitable
   * for referencing from a `demo_evidence` body — it outlives the worktree.
   */
  copyDemoAsset(taskId: string, srcAbsPath: string): string {
    return this.files.copyAsset(taskId, srcAbsPath);
  }

  /** Filenames of the durable demo-assets (videos/screenshots/traces) for a task. */
  listDemoAssets(taskId: string): string[] {
    return this.files.listAssets(taskId);
  }

  /** Absolute path of a demo-asset for serving, or null if missing/unsafe name. */
  demoAssetPath(taskId: string, filename: string): string | null {
    return this.files.assetAbsPath(taskId, filename);
  }

  /** Rewrite an artifact's body on disk and update its byte size. */
  updateArtifactBody(artifactId: string, body: string): Artifact | null {
    const a = this.getArtifact(artifactId);
    if (!a) return null;
    const { byteSize } = this.files.write(a.taskId, artifactId, body);
    this.run(this.db.updateTable('artifacts').set({ byteSize }).where('id', '=', artifactId));
    return this.getArtifact(artifactId);
  }

  /* ---------- Approvals ---------- */
  recordApproval(input: {
    taskId: string;
    gate: Approval['gate'];
    decision: Approval['decision'];
    comment?: string | null;
  }): Approval {
    const row = {
      id: id('apr'),
      taskId: input.taskId,
      gate: input.gate,
      decision: input.decision,
      comment: input.comment ?? null,
      decidedAt: now(),
    };
    this.run(this.db.insertInto('approvals').values(row));
    return row;
  }

  listApprovals(taskId: string): Approval[] {
    return this.all(
      this.db.selectFrom('approvals').selectAll().where('taskId', '=', taskId).orderBy('decidedAt'),
    ) as unknown as Approval[];
  }

  /* ---------- Worktrees ---------- */
  /** Statuses for a worktree that still exists on disk. */
  private static readonly ACTIVE_WT_STATUSES = ['stub', 'created', 'preserved'] as const;

  createWorktree(input: {
    taskId: string;
    worktreePath: string;
    branch: string;
    baseBranch: string;
    status: Worktree['status'];
  }): Worktree {
    const row = {
      id: id('wt'),
      taskId: input.taskId,
      worktreePath: input.worktreePath,
      branch: input.branch,
      baseBranch: input.baseBranch,
      status: input.status,
      createdAt: now(),
    };
    this.run(this.db.insertInto('worktrees').values(row));
    return row;
  }

  getWorktree(taskId: string): Worktree | null {
    return this.get(
      this.db
        .selectFrom('worktrees')
        .selectAll()
        .where('taskId', '=', taskId)
        .orderBy('createdAt', 'desc')
        .limit(1),
    ) as unknown as Worktree | null;
  }

  /** The task's worktree that still exists on disk, if any. */
  getActiveWorktree(taskId: string): Worktree | null {
    return this.get(
      this.db
        .selectFrom('worktrees')
        .selectAll()
        .where('taskId', '=', taskId)
        .where('status', 'in', [...Store.ACTIVE_WT_STATUSES])
        .orderBy('createdAt', 'desc')
        .limit(1),
    ) as unknown as Worktree | null;
  }

  getWorktreeById(worktreeId: string): Worktree | null {
    return this.get(
      this.db.selectFrom('worktrees').selectAll().where('id', '=', worktreeId),
    ) as unknown as Worktree | null;
  }

  updateWorktreeStatus(worktreeId: string, status: Worktree['status']): void {
    this.run(this.db.updateTable('worktrees').set({ status }).where('id', '=', worktreeId));
  }

  /* ---------- Delivery packages ---------- */
  createDeliveryPackage(input: {
    taskId: string;
    artifactId: string | null;
    target: string;
    status: DeliveryPackage['status'];
  }): DeliveryPackage {
    const row = {
      id: id('del'),
      taskId: input.taskId,
      artifactId: input.artifactId,
      target: input.target,
      status: input.status,
      prUrl: null as string | null,
      summary: null as string | null,
      createdAt: now(),
    };
    this.run(this.db.insertInto('delivery_packages').values(row));
    return row;
  }

  /** Record the result of a publish attempt on the task's delivery package. */
  markDeliveryPublished(
    taskId: string,
    input: { status: DeliveryPackage['status']; prUrl: string | null; summary: string },
  ): DeliveryPackage | null {
    const existing = this.getDeliveryPackage(taskId);
    if (!existing) return null;
    this.run(
      this.db
        .updateTable('delivery_packages')
        .set({ status: input.status, prUrl: input.prUrl, summary: input.summary })
        .where('id', '=', existing.id),
    );
    return this.getDeliveryPackage(taskId);
  }

  getDeliveryPackage(taskId: string): DeliveryPackage | null {
    return this.get(
      this.db
        .selectFrom('delivery_packages')
        .selectAll()
        .where('taskId', '=', taskId)
        .orderBy('createdAt', 'desc')
        .limit(1),
    ) as unknown as DeliveryPackage | null;
  }

  /* ---------- Jobs / ValidationRuns (minimal, for future use) ---------- */
  recordValidationRun(input: {
    taskId: string;
    command: string;
    status: ValidationRun['status'];
    artifactId: string | null;
  }): ValidationRun {
    const row = {
      id: id('val'),
      taskId: input.taskId,
      command: input.command,
      status: input.status,
      artifactId: input.artifactId,
      createdAt: now(),
    };
    this.run(this.db.insertInto('validation_runs').values(row));
    return row;
  }

  listValidationRuns(taskId: string): ValidationRun[] {
    return this.all(
      this.db
        .selectFrom('validation_runs')
        .selectAll()
        .where('taskId', '=', taskId)
        .orderBy('createdAt'),
    ) as unknown as ValidationRun[];
  }

  recordJob(input: { taskId: string; kind: string; status: Job['status'] }): Job {
    const row = {
      id: id('job'),
      taskId: input.taskId,
      kind: input.kind,
      status: input.status,
      createdAt: now(),
      finishedAt: null as string | null,
    };
    this.run(this.db.insertInto('jobs').values(row));
    return row;
  }

  /* ---------- Task queue ---------- */
  /** Task statuses that count as "the work is delivered" for satisfying a dependent. */
  private static readonly TERMINAL_TASK_STATUSES = ['done'] as const;

  /** Row shape of a task_queue record (dependsOnIds is hydrated separately). */
  private queueRow(row: unknown): Omit<QueueEntry, 'dependsOnIds'> {
    return row as Omit<QueueEntry, 'dependsOnIds'>;
  }

  /** The predecessor queue-entry ids for one entry, from the edge table. */
  private dependsOnIdsFor(queueId: string): string[] {
    return this.all(
      this.db.selectFrom('queue_dependencies').select('dependsOnId').where('queueId', '=', queueId),
    ).map((r) => (r as { dependsOnId: string }).dependsOnId);
  }

  private hydrate(row: unknown): QueueEntry {
    const base = this.queueRow(row);
    return { ...base, dependsOnIds: this.dependsOnIdsFor(base.id) };
  }

  /**
   * Enqueue a task. `dependsOnIds` (when given) are other queue entries that must
   * each reach `done` before this one becomes eligible — stored as edges in
   * `queue_dependencies`. The unique index on `task_id` means re-enqueuing a task
   * throws — callers should check `getQueueEntryForTask` first. Cycle/validity
   * checks live in the QueueService, not here (this is the dumb persistence seam).
   */
  enqueueTask(input: { taskId: string; dependsOnIds?: string[]; priority?: number }): QueueEntry {
    const tx = this.sqlite.transaction(() => this.insertQueueEntry(input));
    return tx();
  }

  /**
   * Insert one queue entry + its dependency edges. NO transaction of its own so it
   * can be composed inside a larger one (enqueueTask wraps it; createQueueDag runs
   * many in a single transaction). Caller owns atomicity.
   */
  private insertQueueEntry(input: {
    taskId: string;
    dependsOnIds?: string[];
    priority?: number;
  }): QueueEntry {
    const deps = input.dependsOnIds ?? [];
    const row = {
      id: id('q'),
      taskId: input.taskId,
      status: 'queued' as QueueEntryStatus,
      priority: input.priority ?? 0,
      // Legacy column: mirror the first edge so an older read path still sees one.
      dependsOnId: deps[0] ?? null,
      enqueuedAt: now(),
      startedAt: null as string | null,
      completedAt: null as string | null,
    };
    this.run(this.db.insertInto('task_queue').values(row));
    for (const dependsOnId of deps) {
      this.run(
        this.db
          .insertInto('queue_dependencies')
          .values({ queueId: row.id, dependsOnId, createdAt: now() }),
      );
    }
    return { ...row, dependsOnIds: deps };
  }

  /**
   * Create a whole DAG of tasks + queue entries + edges in ONE transaction. Each
   * spec task carries a local `key`; `dependsOn` names sibling keys. The tasks
   * MUST already be in dependency order (predecessors first) — the caller uses
   * `planQueueSpec` to validate + topologically sort. Any failure rolls the whole
   * batch back, so a mid-batch error never leaves a partial DAG. Returns the
   * created queue entries in creation order.
   */
  createQueueDag(input: {
    projectId: string;
    tasks: Array<{
      key: string;
      title: string;
      request: string;
      dependsOnKeys: string[];
      priority?: number;
    }>;
  }): Array<{ key: string; taskId: string; queueEntry: QueueEntry }> {
    const tx = this.sqlite.transaction(() => {
      const queueIdByKey = new Map<string, string>();
      const created: Array<{ key: string; taskId: string; queueEntry: QueueEntry }> = [];
      for (const t of input.tasks) {
        const task = this.createTaskRow(input.projectId, t.title, t.request);
        const dependsOnIds = t.dependsOnKeys.map((k) => {
          const qid = queueIdByKey.get(k);
          if (!qid) throw new Error(`task "${t.key}" dependsOn "${k}" which was not created first`);
          return qid;
        });
        const queueEntry = this.insertQueueEntry({
          taskId: task.id,
          dependsOnIds,
          ...(t.priority === undefined ? {} : { priority: t.priority }),
        });
        queueIdByKey.set(t.key, queueEntry.id);
        created.push({ key: t.key, taskId: task.id, queueEntry });
      }
      return created;
    });
    return tx();
  }

  listQueue(): QueueEntry[] {
    const rows = this.all(
      this.db
        .selectFrom('task_queue')
        .selectAll()
        .orderBy('priority', 'desc')
        .orderBy('enqueuedAt')
        .orderBy(sql`rowid`),
    );
    return rows.map((r) => this.hydrate(r));
  }

  getQueueEntry(queueId: string): QueueEntry | null {
    const row = this.get(this.db.selectFrom('task_queue').selectAll().where('id', '=', queueId));
    return row === null ? null : this.hydrate(row);
  }

  getQueueEntryForTask(taskId: string): QueueEntry | null {
    const row = this.get(this.db.selectFrom('task_queue').selectAll().where('taskId', '=', taskId));
    return row === null ? null : this.hydrate(row);
  }

  setQueueStatus(queueId: string, status: QueueEntryStatus): QueueEntry | null {
    const patch: { status: QueueEntryStatus; startedAt?: string; completedAt?: string } = {
      status,
    };
    if (status === 'running') patch.startedAt = now();
    if (status === 'done' || status === 'failed') patch.completedAt = now();
    this.run(this.db.updateTable('task_queue').set(patch).where('id', '=', queueId));
    return this.getQueueEntry(queueId);
  }

  /**
   * Queue entries that are ready to run: `status = 'queued'` AND no unmet
   * dependency — i.e. there is NO edge from the entry to a predecessor whose
   * *task* has not reached a terminal status (`done`). An entry with no edges is
   * therefore always ready. Ordered by priority desc then enqueued_at asc (rowid
   * tiebreak) so the caller can run them in scheduling order.
   */
  listEligibleQueued(): QueueEntry[] {
    const rows = this.all(
      this.db
        .selectFrom('task_queue as q')
        .selectAll('q')
        .where('q.status', '=', 'queued')
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('queue_dependencies as d')
                .innerJoin('task_queue as p', 'p.id', 'd.dependsOnId')
                .innerJoin('tasks as pt', 'pt.id', 'p.taskId')
                .select(sql`1`.as('one'))
                .whereRef('d.queueId', '=', 'q.id')
                .where('pt.status', 'not in', [...Store.TERMINAL_TASK_STATUSES]),
            ),
          ),
        )
        .orderBy('q.priority', 'desc')
        .orderBy('q.enqueuedAt')
        // `rowid` (insertion order) breaks ties for entries enqueued in the same
        // millisecond so FIFO is deterministic.
        .orderBy(sql`q.rowid`),
    );
    return rows.map((r) => this.hydrate(r));
  }

  /** Queue entries currently in flight (handed to the driver, not yet terminal). */
  listRunningQueue(): QueueEntry[] {
    const rows = this.all(
      this.db.selectFrom('task_queue').selectAll().where('status', '=', 'running'),
    );
    return rows.map((r) => this.hydrate(r));
  }

  /* ---------- Agent runs ---------- */
  /** Payloads larger than this are spilled to the artifact file store. */
  private static readonly EVENT_PAYLOAD_INLINE_LIMIT = 8 * 1024;

  createAgentRun(input: { taskId: string; stage: Stage }): AgentRun {
    const row = {
      id: id('arun'),
      taskId: input.taskId,
      stage: input.stage,
      status: 'running' as AgentRunStatus,
      startedAt: now(),
      finishedAt: null as string | null,
      totalCostUsd: null as number | null,
      numTurns: null as number | null,
      inputTokens: null as number | null,
      outputTokens: null as number | null,
      cacheCreationInputTokens: null as number | null,
      cacheReadInputTokens: null as number | null,
      durationApiMs: null as number | null,
      ttftMs: null as number | null,
      error: null as string | null,
      sessionId: null as string | null,
      pgid: null as number | null,
    };
    this.run(this.db.insertInto('agent_runs').values(row));
    return row;
  }

  /**
   * The most recent succeeded run for a task's stage that captured a Claude
   * session id — the session to `--resume` for a rejection redo. Null when no
   * such run exists (mock runtime, or the run predates session capture).
   */
  latestSessionForStage(taskId: string, stage: Stage): string | null {
    const row = this.get(
      this.db
        .selectFrom('agent_runs')
        .select('sessionId')
        .where('taskId', '=', taskId)
        .where('stage', '=', stage)
        .where('status', '=', 'succeeded')
        .where('sessionId', 'is not', null)
        // Newest by start time; `rowid` breaks ties for runs created in the same
        // millisecond so the result is deterministic (insertion order).
        .orderBy('startedAt', 'desc')
        .orderBy(sql`rowid`, 'desc'),
    ) as unknown as { sessionId: string | null } | null;
    return row?.sessionId ?? null;
  }

  getAgentRun(runId: string): AgentRun | null {
    return this.get(
      this.db.selectFrom('agent_runs').selectAll().where('id', '=', runId),
    ) as unknown as AgentRun | null;
  }

  listAgentRuns(taskId: string): AgentRun[] {
    return this.all(
      this.db
        .selectFrom('agent_runs')
        .selectAll()
        .where('taskId', '=', taskId)
        .orderBy('startedAt'),
    ) as unknown as AgentRun[];
  }

  /**
   * All runs currently in the `interrupted` state — the boot-reconciliation work
   * list (set by {@link markInterruptedRuns}). Newest first so the most recent
   * interrupted run per task is reconciled first.
   */
  listInterruptedRuns(): AgentRun[] {
    return this.all(
      this.db
        .selectFrom('agent_runs')
        .selectAll()
        .where('status', '=', 'interrupted')
        .orderBy('startedAt', 'desc'),
    ) as unknown as AgentRun[];
  }

  updateAgentRun(
    runId: string,
    patch: Partial<
      Pick<
        AgentRun,
        | 'status'
        | 'finishedAt'
        | 'totalCostUsd'
        | 'numTurns'
        | 'inputTokens'
        | 'outputTokens'
        | 'cacheCreationInputTokens'
        | 'cacheReadInputTokens'
        | 'durationApiMs'
        | 'ttftMs'
        | 'error'
        | 'sessionId'
        | 'pgid'
      >
    >,
  ): void {
    this.run(this.db.updateTable('agent_runs').set(patch).where('id', '=', runId));
  }

  /**
   * Mark any non-terminal run `interrupted` — called FIRST on daemon boot. A run
   * left `running`/`awaiting_input` by a prior process can't be driven by its
   * (gone) in-memory state, so it's an orphan. We mark it `interrupted` (not
   * `failed`) so boot reconciliation can tell "daemon vanished, maybe resume"
   * from "the run errored": the resume engine acts only on `interrupted` rows.
   *
   * Returns the affected rows (with `pgid`/`sessionId`/`taskId`/`stage`) so the
   * caller can reap the orphaned process group and resume the conversation. A
   * terminal `error` event is still appended so any SSE client attached to the
   * old run stops reconnect-replaying — a successfully resumed run starts under a
   * NEW run id, so this closed event log is never reopened.
   */
  markInterruptedRuns(reason = 'daemon restarted while run was active'): AgentRun[] {
    const orphans = this.all(
      this.db
        .selectFrom('agent_runs')
        .selectAll()
        .where('status', 'in', ['running', 'awaiting_input']),
    ) as unknown as AgentRun[];
    for (const run of orphans) {
      this.updateAgentRun(run.id, { status: 'interrupted', finishedAt: now(), error: reason });
      this.appendAgentRunEvent({ runId: run.id, type: 'error', payload: { message: reason } });
    }
    return orphans;
  }

  /* ---------- Agent run events ---------- */
  /** The next monotonic seq for a run (max existing + 1, starting at 1). */
  private nextEventSeq(runId: string): number {
    const row = this.get(
      this.db
        .selectFrom('agent_run_events')
        .select((eb) => eb.fn.max('seq').as('maxSeq'))
        .where('runId', '=', runId),
    ) as unknown as { maxSeq: number | null } | null;
    return (row?.maxSeq ?? 0) + 1;
  }

  appendAgentRunEvent(input: {
    runId: string;
    type: AgentRunEventType;
    payload: unknown;
    /**
     * When the daemon received the event (parse time). Defaults to insert time
     * when the caller doesn't stamp it, so it is never null on a fresh write —
     * divergence from `createdAt` is the daemon-persist-delay signal.
     */
    receivedAt?: string;
  }): AgentRunEvent {
    const seq = this.nextEventSeq(input.runId);
    const json = JSON.stringify(input.payload ?? null);
    const spill = json.length > Store.EVENT_PAYLOAD_INLINE_LIMIT;
    const eventId = id('aev');
    let bodyPath: string | null = null;
    if (spill) {
      // Reuse the artifact file store for oversized payloads (keyed by run id).
      bodyPath = this.files.write(input.runId, eventId, json).relPath;
    }
    const receivedAt = input.receivedAt ?? now();
    const row = {
      id: eventId,
      runId: input.runId,
      seq,
      type: input.type,
      payloadJson: spill ? null : json,
      bodyPath,
      createdAt: now(),
      receivedAt,
    };
    this.run(this.db.insertInto('agent_run_events').values(row));
    return {
      id: eventId,
      runId: input.runId,
      seq,
      type: input.type,
      payload: input.payload,
      createdAt: row.createdAt,
      receivedAt,
    };
  }

  /** Events for a run in seq order; `afterSeq` supports SSE `Last-Event-ID` replay. */
  listAgentRunEvents(runId: string, afterSeq = 0): AgentRunEvent[] {
    const rows = this.all(
      this.db
        .selectFrom('agent_run_events')
        .selectAll()
        .where('runId', '=', runId)
        .where('seq', '>', afterSeq)
        .orderBy('seq'),
    ) as unknown as {
      id: string;
      runId: string;
      seq: number;
      type: AgentRunEventType;
      payloadJson: string | null;
      bodyPath: string | null;
      createdAt: string;
      receivedAt: string | null;
    }[];
    return rows.map((r) => {
      const json = r.payloadJson ?? (r.bodyPath ? this.files.read(r.bodyPath) : null);
      return {
        id: r.id,
        runId: r.runId,
        seq: r.seq,
        type: r.type,
        payload: json ? (JSON.parse(json) as unknown) : null,
        createdAt: r.createdAt,
        receivedAt: r.receivedAt ?? null,
      };
    });
  }

  /* ---------- Agent questions ---------- */
  createAgentQuestion(input: {
    runId: string;
    taskId: string;
    header: string;
    question: string;
    options: AgentQuestionOption[] | null;
    multiSelect: boolean;
    permission?: { toolName: string; toolInput: unknown } | null;
  }): AgentQuestion {
    const row = {
      id: id('aq'),
      runId: input.runId,
      taskId: input.taskId,
      header: input.header,
      question: input.question,
      optionsJson: input.options ? JSON.stringify(input.options) : null,
      multiSelect: input.multiSelect ? 1 : 0,
      permissionJson: input.permission ? JSON.stringify(input.permission) : null,
      answerJson: null as string | null,
      askedAt: now(),
      answeredAt: null as string | null,
    };
    this.run(this.db.insertInto('agent_questions').values(row));
    return this.getAgentQuestion(row.id)!;
  }

  getAgentQuestion(questionId: string): AgentQuestion | null {
    const row = this.get(
      this.db.selectFrom('agent_questions').selectAll().where('id', '=', questionId),
    ) as unknown as AgentQuestionsTableRow | null;
    return row ? Store.toAgentQuestion(row) : null;
  }

  recordAnswer(questionId: string, answer: AgentQuestionAnswer): AgentQuestion {
    this.run(
      this.db
        .updateTable('agent_questions')
        .set({ answerJson: JSON.stringify(answer), answeredAt: now() })
        .where('id', '=', questionId),
    );
    return this.getAgentQuestion(questionId)!;
  }

  /** Unanswered questions for a run (used to know when a run can resume). */
  listUnansweredForRun(runId: string): AgentQuestion[] {
    const rows = this.all(
      this.db
        .selectFrom('agent_questions')
        .selectAll()
        .where('runId', '=', runId)
        .where('answerJson', 'is', null)
        .orderBy('askedAt'),
    ) as unknown as AgentQuestionsTableRow[];
    return rows.map(Store.toAgentQuestion);
  }

  /** Unanswered questions across all of a task's runs (gate-gating enforcement). */
  listUnansweredForTask(taskId: string): AgentQuestion[] {
    const rows = this.all(
      this.db
        .selectFrom('agent_questions')
        .selectAll()
        .where('taskId', '=', taskId)
        .where('answerJson', 'is', null)
        .orderBy('askedAt'),
    ) as unknown as AgentQuestionsTableRow[];
    return rows.map(Store.toAgentQuestion);
  }

  private static toAgentQuestion(row: AgentQuestionsTableRow): AgentQuestion {
    return {
      id: row.id,
      runId: row.runId,
      taskId: row.taskId,
      header: row.header,
      question: row.question,
      options: row.optionsJson ? (JSON.parse(row.optionsJson) as AgentQuestionOption[]) : null,
      multiSelect: row.multiSelect === 1,
      permission: row.permissionJson
        ? (JSON.parse(row.permissionJson) as { toolName: string; toolInput: unknown })
        : null,
      answer: row.answerJson ? (JSON.parse(row.answerJson) as AgentQuestionAnswer) : null,
      askedAt: row.askedAt,
      answeredAt: row.answeredAt,
    };
  }
}

/** The raw (JSON-as-string) shape of an agent_questions row. */
interface AgentQuestionsTableRow {
  id: string;
  runId: string;
  taskId: string;
  header: string;
  question: string;
  optionsJson: string | null;
  multiSelect: number;
  permissionJson: string | null;
  answerJson: string | null;
  askedAt: string;
  answeredAt: string | null;
}
