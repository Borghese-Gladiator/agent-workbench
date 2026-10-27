/**
 * The typed database schema — the single source of truth Kysely checks every
 * query against.
 *
 * Identifiers are camelCase here. The Store configures Kysely with
 * CamelCasePlugin, which maps these camelCase names to the snake_case columns in
 * SQL at runtime. Keeping the interface camelCase means query inputs/outputs use
 * the same names as the @workbench/core domain types, so selected rows map onto
 * those types directly.
 *
 * A query referencing a property that isn't here is a compile error — which is
 * exactly what prevents the schema/code drift this package previously had.
 */

export interface ProjectsTable {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  defaultBranch: string;
  agentRuntime: string;
  /** Per-runtime config (model/baseUrl/binary) as a JSON string; null/'' before set. */
  runtimeConfigJson: string | null;
  /** External helper tools (ExternalToolConfig[]) as a JSON string; null when none. */
  externalToolsJson: string | null;
  deliveryPolicy: string;
  testCommand: string;
  lintCommand: string;
  typecheckCommand: string;
  e2eCommand: string;
  devCommand: string;
  createdAt: string;
}

export interface TasksTable {
  id: string;
  projectId: string;
  title: string;
  rawRequest: string;
  stage: string;
  status: string;
  worktreeId: string | null;
  worktreeMode: string;
  /** 0/1 — whether the human opted to skip feature E2E at the plan gate (migration 0014). */
  skipE2e: number;
  createdAt: string;
  updatedAt: string;
  /** Optimistic-locking counter; bumped on every task UPDATE (migration 0012). */
  rev: number;
}

export interface StageRunsTable {
  id: string;
  taskId: string;
  stage: string;
  status: string;
  enteredAt: string;
  completedAt: string | null;
  note: string | null;
}

export interface ArtifactsTable {
  id: string;
  taskId: string;
  stageRunId: string | null;
  kind: string;
  title: string;
  bodyPath: string;
  byteSize: number;
  createdAt: string;
}

export interface ApprovalsTable {
  id: string;
  taskId: string;
  gate: string;
  decision: string;
  comment: string | null;
  decidedAt: string;
}

export interface WorktreesTable {
  id: string;
  taskId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  status: string;
  createdAt: string;
}

export interface JobsTable {
  id: string;
  taskId: string;
  kind: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface ValidationRunsTable {
  id: string;
  taskId: string;
  command: string;
  status: string;
  artifactId: string | null;
  createdAt: string;
}

export interface DeliveryPackagesTable {
  id: string;
  taskId: string;
  artifactId: string | null;
  target: string;
  status: string;
  prUrl: string | null;
  summary: string | null;
  createdAt: string;
}

export interface AgentRunsTable {
  id: string;
  taskId: string;
  stage: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  totalCostUsd: number | null;
  numTurns: number | null;
  /** Per-run token breakdown from the CLI `result.usage`; null for mock/legacy runs. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  /** True model-API latency (CLI `duration_api_ms`); null for mock/legacy runs. */
  durationApiMs: number | null;
  /** First-turn time-to-first-token (ms); null for mock/legacy runs. */
  ttftMs: number | null;
  error: string | null;
  /** Claude CLI session id (for `--resume`); null for mock/legacy runs. */
  sessionId: string | null;
  /** Process-group id of the spawned CLI (for boot-time orphan reaping); null for mock/legacy runs. */
  pgid: number | null;
}

export interface AgentRunEventsTable {
  id: string;
  runId: string;
  seq: number;
  type: string;
  /** Inline bounded JSON payload; null when spilled to bodyPath. */
  payloadJson: string | null;
  /** Relative artifact-file path for oversized payloads; null when inline. */
  bodyPath: string | null;
  createdAt: string;
  /** When the daemon received the event (parse time), vs `createdAt` (insert time); null for legacy rows. */
  receivedAt: string | null;
}

export interface AgentQuestionsTable {
  id: string;
  runId: string;
  taskId: string;
  header: string;
  question: string;
  /** JSON array of {label,description}; null for free-text. */
  optionsJson: string | null;
  multiSelect: number;
  /** JSON {toolName,toolInput} when this came from a permission boundary. */
  permissionJson: string | null;
  /** JSON {selected:[]} | {text:string}; null until answered. */
  answerJson: string | null;
  askedAt: string;
  answeredAt: string | null;
}

export interface TaskQueueTable {
  id: string;
  taskId: string;
  status: string;
  priority: number;
  /** Legacy single-predecessor column. Superseded by queue_dependencies (edges); no longer read. */
  dependsOnId: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** One directed edge in the queue DAG: `queueId` waits on `dependsOnId`'s task. */
export interface QueueDependenciesTable {
  queueId: string;
  dependsOnId: string;
  createdAt: string;
}

/**
 * The full schema, keyed by table name. Table keys stay snake_case (real SQL
 * table names); CamelCasePlugin only transforms column identifiers, not the
 * `selectFrom('stage_runs')` table argument.
 */
export interface Database {
  projects: ProjectsTable;
  tasks: TasksTable;
  stage_runs: StageRunsTable;
  artifacts: ArtifactsTable;
  approvals: ApprovalsTable;
  worktrees: WorktreesTable;
  jobs: JobsTable;
  validation_runs: ValidationRunsTable;
  delivery_packages: DeliveryPackagesTable;
  agent_runs: AgentRunsTable;
  agent_run_events: AgentRunEventsTable;
  agent_questions: AgentQuestionsTable;
  task_queue: TaskQueueTable;
  queue_dependencies: QueueDependenciesTable;
}
