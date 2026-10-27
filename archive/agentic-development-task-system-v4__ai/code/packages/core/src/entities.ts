import type { ArtifactKind } from './artifacts.js';
import type { HumanReviewDecision, Stage, TaskStatus } from './lifecycle.js';

/** ISO-8601 timestamp string. */
export type Timestamp = string;

/** Which agent runtime a project's stage agents run on. */
export const AGENT_RUNTIMES = ['mock', 'claude', 'pi', 'codex'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === 'string' && (AGENT_RUNTIMES as readonly string[]).includes(value);
}

/** How a task's work is implemented: an isolated git worktree, or directly on the checkout. */
export const WORKTREE_MODES = ['worktree', 'direct'] as const;
export type WorktreeMode = (typeof WORKTREE_MODES)[number];

export function isWorktreeMode(value: unknown): value is WorktreeMode {
  return typeof value === 'string' && (WORKTREE_MODES as readonly string[]).includes(value);
}

/**
 * Per-project configuration for the chosen agent runtime. Deliberately small and
 * runtime-neutral: the {@link AgentRuntime}'s profile interprets these values in
 * its own vocabulary (e.g. the Claude profile reads `model` as a CLI alias like
 * `opus`; the Pi profile reads it as a `provider/id` like `ollama/qwen3-coder:30b`).
 *
 * No credentials live here — auth is handled out of band by the runtime's own
 * login (Claude Code session, `pi` provider auth / `~/.pi/agent/models.json`,
 * env vars). All fields optional: an absent config means "use the runtime's
 * built-in defaults", which is the only sane behavior for the `mock` runtime.
 */
export interface RuntimeConfig {
  /** Default model for the runtime, in that runtime's own naming. */
  model?: string;
  /** Base URL for an OpenAI-compatible / self-hosted endpoint, when relevant. */
  baseUrl?: string;
  /** Path/name of the runtime binary (override the profile default, e.g. for `pi`). */
  binary?: string;
}

/**
 * An external helper tool a project's stage agents may use — a CLI living in its
 * own repo OUTSIDE the task worktree (e.g. `klaviyo-local-seed`, which seeds the
 * local app dev env). The workbench stays tool-agnostic: it only knows where the
 * tool lives and which of its docs to inline into which stage prompts. Everything
 * tool-specific (commands, gotchas) lives in the tool's own repo.
 *
 * Doc injection is tiered so any model can use the tool (see RuntimeProfile.toolDocTier):
 * every listed stage gets the short per-stage recipe card (`<root>/<recipesDir>/<stage>.md`,
 * literal copy-paste commands a small model can follow); `full`-tier runtimes
 * additionally get the complete doc (`<root>/<docPath>`).
 */
export interface ExternalToolConfig {
  /** Display name, used as the prompt section heading. */
  name: string;
  /** Absolute path to the tool's repo/checkout. */
  root: string;
  /** Path (relative to root) of the full agent doc, e.g. `CLAUDE.md`. */
  docPath?: string;
  /** Path (relative to root) of the dir holding per-stage recipe cards (`<stage>.md`). */
  recipesDir?: string;
  /** Stages whose prompts get this tool injected. */
  stages: Stage[];
}

/**
 * How a project's completed work is delivered. This is intentionally
 * independent of how the work is *implemented* (see {@link Task.worktreeMode}):
 * a worktree task can merge to the default branch, and a direct task can open a
 * PR. `worktreeMode` decides the cwd/branch; `DeliveryPolicy` decides the action.
 */
export const DELIVERY_POLICIES = ['create_pr', 'merge_to_master'] as const;
export type DeliveryPolicy = (typeof DELIVERY_POLICIES)[number];

export function isDeliveryPolicy(value: unknown): value is DeliveryPolicy {
  return typeof value === 'string' && (DELIVERY_POLICIES as readonly string[]).includes(value);
}

/**
 * Coerce a stored value (which may be a legacy free-form string from before
 * delivery policy was typed) into a valid {@link DeliveryPolicy}. Unknown values
 * default to `merge_to_master`.
 */
export function normalizeDeliveryPolicy(value: unknown): DeliveryPolicy {
  return value === 'create_pr' ? 'create_pr' : 'merge_to_master';
}

export interface Project {
  id: string;
  name: string;
  /** Short free-form description of what this project is. */
  description: string;
  repoPath: string;
  defaultBranch: string;
  /** Which runtime stage agents run on for this project. Defaults to `mock`. */
  agentRuntime: AgentRuntime;
  /**
   * Per-runtime configuration (model/baseUrl/binary), interpreted by the runtime's
   * profile. Empty `{}` for `mock` and for runtimes left on their defaults.
   */
  runtimeConfig: RuntimeConfig;
  /** How completed work is delivered: open a PR, or merge to the default branch. */
  deliveryPolicy: DeliveryPolicy;
  /** External helper tools stage agents may use. Empty for most projects. */
  externalTools: ExternalToolConfig[];
  testCommand: string;
  lintCommand: string;
  typecheckCommand: string;
  e2eCommand: string;
  devCommand: string;
  createdAt: Timestamp;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  rawRequest: string;
  stage: Stage;
  status: TaskStatus;
  /** Set once a worktree is created (stubbed this increment). */
  worktreeId: string | null;
  /**
   * Whether the task works in an isolated worktree branch (`'worktree'`, default)
   * or commits directly on the project's `defaultBranch` (`'direct'`). When set
   * to `'direct'`, no worktree is created and all downstream cwd resolves to
   * `project.repoPath`.
   */
  worktreeMode: WorktreeMode;
  /**
   * Whether the human opted to skip the feature E2E stage at the plan-approval
   * gate. When true, `completeStaticChecks` routes past `feature_e2e` straight to
   * agent self-review. Static checks (typecheck/test/lint) always still run.
   */
  skipE2e: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /**
   * Optimistic-locking revision. Bumped on every task UPDATE; a guarded write
   * that reads a stale `rev` affects 0 rows and is rejected (StaleWriteError),
   * so concurrent mutations of the same task fail loudly instead of one
   * silently clobbering the other.
   */
  rev: number;
}

/**
 * A StageRun records one entry into a stage. Re-entering a stage (e.g. after a
 * bounce) produces a new StageRun, so the timeline is a faithful history rather
 * than a single current-stage pointer.
 */
export interface StageRun {
  id: string;
  taskId: string;
  stage: Stage;
  status: 'in_progress' | 'completed' | 'superseded';
  enteredAt: Timestamp;
  completedAt: Timestamp | null;
  /** Optional note about why this stage run happened (e.g. "bounce from human_review"). */
  note: string | null;
}

export interface Artifact {
  id: string;
  taskId: string;
  stageRunId: string | null;
  kind: ArtifactKind;
  title: string;
  /** Relative path under the data/artifacts dir; body lives on disk, not in DB. */
  bodyPath: string;
  /** Bytes of the stored body, for display. */
  byteSize: number;
  createdAt: Timestamp;
}

export interface Approval {
  id: string;
  taskId: string;
  /** Which gate this approval is for. */
  gate: 'task_brief' | 'execution_plan' | 'human_review' | 'delivery';
  decision: 'approved' | 'rejected' | 'edited' | HumanReviewDecision;
  /** Optional edited content or reviewer comment. */
  comment: string | null;
  decidedAt: Timestamp;
}

export interface Worktree {
  id: string;
  taskId: string;
  /** Absolute path to the per-task git worktree on disk. */
  worktreePath: string;
  /** Branch created for this task: `<slug>-<short-id>`. */
  branch: string;
  /** Branch the worktree was created from (the project's default branch). */
  baseBranch: string;
  status: 'stub' | 'created' | 'removed' | 'abandoned' | 'preserved';
  createdAt: Timestamp;
}

export interface Job {
  id: string;
  taskId: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: Timestamp;
  finishedAt: Timestamp | null;
}

export interface ValidationRun {
  id: string;
  taskId: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  artifactId: string | null;
  createdAt: Timestamp;
}

/** Lifecycle of a queue entry, independent of the task's own stage/status. */
export const QUEUE_ENTRY_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type QueueEntryStatus = (typeof QUEUE_ENTRY_STATUSES)[number];

/**
 * One enqueued task in the multi-task queue. The scheduler runs a `queued` entry
 * once every predecessor in `dependsOnIds` (other queue entries) has reached
 * `done`, picking among eligible entries by priority desc then `enqueuedAt` asc
 * (FIFO). Dependencies are stored as edges (see `queue_dependencies`), so an
 * entry can wait on many predecessors — chains, fan-out, and fan-in all work.
 *
 * A queue entry's status is orthogonal to the task's own stage/status: `running`
 * means the scheduler has handed the task to the lifecycle driver (it may be
 * parked at a human gate), and `done` means the task reached a terminal status
 * (its work is delivered) — only then does it satisfy a dependent.
 */
export interface QueueEntry {
  id: string;
  taskId: string;
  status: QueueEntryStatus;
  /** Higher runs first among eligible entries; ties broken by enqueuedAt (FIFO). */
  priority: number;
  /** Queue entries this one waits on; empty = eligible immediately. All must reach `done`. */
  dependsOnIds: string[];
  enqueuedAt: Timestamp;
  /** When the scheduler first handed this entry to the driver. */
  startedAt: Timestamp | null;
  /** When the entry reached `done`/`failed`. */
  completedAt: Timestamp | null;
}

export interface DeliveryPackage {
  id: string;
  taskId: string;
  artifactId: string | null;
  /** Where it goes (branch / PR title). */
  target: string;
  status: 'prepared' | 'approved' | 'published';
  /** URL of the opened PR, once published (null for dry-run / not-yet-published). */
  prUrl: string | null;
  /** Human-readable result of the publish attempt. */
  summary: string | null;
  createdAt: Timestamp;
}
