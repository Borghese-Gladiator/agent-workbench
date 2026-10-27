/**
 * Response/payload shapes for the daemon HTTP API.
 *
 * These mirror daemon-side shapes (some originate in @workbench/worktree /
 * @workbench/agents) but are declared here so a consumer — the browser bundle
 * especially — never has to import those node-only packages just to type a
 * response. The domain entities themselves come from @workbench/core.
 */
import type {
  Approval,
  Artifact,
  DeliveryPackage,
  Project,
  StageRun,
  Task,
  Worktree,
} from '@workbench/core';

/** A durable QA proof asset; `kind` drives how the center panel renders it. */
export type AssetKind = 'video' | 'image' | 'trace' | 'other';
export interface DemoAsset {
  name: string;
  kind: AssetKind;
}

/** Mirror of the daemon's git-status shape (from @workbench/worktree). */
export interface ChangedFile {
  path: string;
  status: string;
}
export interface GitStatus {
  branch: string;
  baseBranch: string | null;
  ahead: number;
  behind: number;
  changedFiles: ChangedFile[];
  clean: boolean;
}

/** Mirror of core's AgentRun (avoids importing node-only deps). */
export type AgentRunStatus = 'running' | 'awaiting_input' | 'succeeded' | 'failed';
export interface AgentRun {
  id: string;
  taskId: string;
  stage: string;
  status: AgentRunStatus;
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
}

export interface AgentRunEvent {
  id: string;
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
  /** Daemon receive time (parse time), vs `createdAt` (insert time); null for legacy rows. */
  receivedAt?: string | null;
}

export interface AgentQuestionOption {
  label: string;
  description: string;
}
export type AgentQuestionAnswer = { selected: string[] } | { text: string };
export interface AgentQuestion {
  id: string;
  runId: string;
  taskId: string;
  header: string;
  question: string;
  options: AgentQuestionOption[] | null;
  multiSelect: boolean;
  permission: { toolName: string; toolInput: unknown } | null;
  answer: AgentQuestionAnswer | null;
}

export interface TaskDetail {
  task: Task;
  project: Project | null;
  /** True when the project targets the workbench itself — skip-worktree is refused. */
  selfTargeting: boolean;
  stageRuns: StageRun[];
  artifacts: Artifact[];
  approvals: Approval[];
  worktree: Worktree | null;
  delivery: DeliveryPackage | null;
  agentRuns: AgentRun[];
}
