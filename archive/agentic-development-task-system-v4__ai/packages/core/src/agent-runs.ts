import type { Timestamp } from './entities.js';
import type { Stage } from './lifecycle.js';

/**
 * An AgentRun is a first-class, observable record of one execution of a stage
 * agent. Unlike a StageRun (which records lifecycle entry into a stage), an
 * AgentRun records a single invocation of the runtime adapter and carries a
 * streamed event log. Running an agent does NOT advance the lifecycle.
 */
export const AGENT_RUN_STATUSES = [
  'running',
  /** Paused mid-run, blocked on a human answer to an AgentQuestion. */
  'awaiting_input',
  'succeeded',
  'failed',
  /**
   * Daemon vanished mid-run (set on boot for any row left running/awaiting_input).
   * Distinct from `failed`: the run did not error — its conversation may be
   * intact and is a CANDIDATE for resume. Transient: boot reconciliation moves it
   * to a terminal state or supersedes it with a fresh resumed run.
   */
  'interrupted',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

/** A terminal status no longer accepts events or answers. */
export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

/**
 * Per-run token usage, summed across all the model requests in one agent run.
 * Mirrors the Anthropic `usage` object the `claude` CLI emits on its terminal
 * `result` line. `cacheReadInputTokens` is the one to watch: on resumed
 * sessions (plan/impl rejections) it dominates, and it's the main lever for
 * reducing spend. All null for mock runs and runs predating usage capture.
 */
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

/**
 * Payload of a `cost` stream event: the authoritative `total_cost_usd` +
 * `num_turns` from the CLI, plus the token breakdown. Shared by the adapter
 * (emits), the executor (persists), and the UI (renders) so the shape can't
 * drift across layers.
 */
export interface CostEventPayload extends TokenUsage {
  totalCostUsd: number | null;
  numTurns: number | null;
  /**
   * Total wall-clock the CLI reports for the turn (`duration_ms`) and the slice
   * of that spent in the model API (`duration_api_ms`). Together these give the
   * TRUE model-API latency vs the rest (tool exec + overhead), which the
   * timestamp-derived split in the profiler can only approximate. Null for mock
   * runs and runs predating capture.
   */
  durationMs: number | null;
  durationApiMs: number | null;
}

export interface AgentRun extends TokenUsage {
  id: string;
  taskId: string;
  stage: Stage;
  status: AgentRunStatus;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
  totalCostUsd: number | null;
  numTurns: number | null;
  /**
   * True model-API latency for the run, from the CLI `result` line's
   * `duration_api_ms` (carried on the terminal `cost` event). Persisted on the
   * row so it's queryable/sortable without replaying the event stream. Null for
   * mock runs and runs predating capture.
   */
  durationApiMs: number | null;
  /**
   * The run's first-turn time-to-first-token (ms), lifted from the first `turn`
   * event — a coarse "how long until this run said anything" signal that lives
   * on the row. Per-turn TTFT detail still requires the event stream (`turn`
   * events / `turnStats`). Null for mock runs and runs predating turn markers.
   */
  ttftMs: number | null;
  error: string | null;
  /**
   * The Claude CLI session id this run belongs to, captured from the stream's
   * `system`/`init` event. Persisted so a later run can `--resume` it — e.g. a
   * brief rejection resumes the brief's session and sends only the reviewer's
   * comment, instead of re-prompting from scratch. Null for mock runs and runs
   * predating session capture.
   */
  sessionId: string | null;
  /**
   * Process-group id of the spawned CLI, captured at spawn. The claude process
   * and its child MCP ask-server share this group, so a single group-kill reaps
   * the whole tree. Persisted so a daemon boot can reap a process group orphaned
   * by a prior crash. Null for mock runs (nothing spawned) and legacy rows.
   */
  pgid: number | null;
}

/**
 * The event types streamed from a run. These map from the `claude` CLI's
 * `--output-format stream-json` NDJSON (assistant text / tool use / tool
 * result / cost / terminal result) plus the workbench's own gate events
 * (`ask_question` / `question_answered`).
 */
export const AGENT_RUN_EVENT_TYPES = [
  'assistant_text',
  'tool_call',
  'tool_result',
  'ask_question',
  'question_answered',
  /**
   * One per model turn, emitted at the turn's first model emission. Carries the
   * per-turn time-to-first-token (`ttftMs`) and that turn's request token usage —
   * the data that separates input-prefill latency from output-generation latency
   * (the long silent gaps inside a single `claude -p` run). See `TurnEventPayload`.
   */
  'turn',
  'cost',
  'result',
  'error',
] as const;

export type AgentRunEventType = (typeof AGENT_RUN_EVENT_TYPES)[number];

/**
 * Payload of a `turn` event: one per model turn within a single agent run,
 * stamped at the turn's first model emission (the `assistant` stream line).
 *
 * `ttftMs` is the time-to-first-token for that turn — measured from the turn
 * boundary (the prior `tool_result` sent back to the model, or run start for the
 * first turn) to this first model line. This is the long silent gap the brief is
 * chasing; correlating it against the token fields answers WHY:
 *   - ttft vs `inputTokens`           → H1 (large-context prefill)
 *   - ttft vs cache-read ratio        → H2 (no prompt caching)
 *   - ttft vs `outputTokens`          → H3 (raw generation)
 *   - ttft ≈ constant                 → H4 (server-side queueing)
 *
 * Token fields come from the `assistant` line's `message.usage` (Anthropic
 * Messages shape: the REQUEST's input + cache counts, plus output-so-far at
 * first token). All null when the CLI omits usage (older versions, mock runs).
 */
export interface TurnEventPayload {
  /** 1-based turn number within the run. */
  index: number;
  /** ms from the turn boundary to this turn's first model emission; null if unmeasurable. */
  ttftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

/**
 * A single streamed event. `seq` is monotonic per run so a reconnecting SSE
 * client can resume via `Last-Event-ID`. `payload` is a bounded JSON value;
 * large payloads are spilled to the artifact file store and referenced by
 * `bodyPath` instead (the store layer decides the threshold).
 */
export interface AgentRunEvent {
  id: string;
  runId: string;
  seq: number;
  type: AgentRunEventType;
  payload: unknown;
  createdAt: Timestamp;
  /**
   * When the daemon RECEIVED this event from the adapter (stamped as the parsed
   * stream line enters `emit`), vs `createdAt` which is stamped at the SQLite
   * insert. Divergence between the two isolates daemon-side persist delay from
   * model-side latency without post-hoc archaeology. Null for legacy rows
   * predating dual timestamps.
   */
  receivedAt: Timestamp | null;
}

/** An option in a structured question (Anthropic `AskUserQuestion` shape). */
export interface AgentQuestionOption {
  label: string;
  description: string;
}

/** The human's answer to a question: selected option labels, or free text. */
export type AgentQuestionAnswer = { selected: string[] } | { text: string };

/**
 * A structured question an agent raised mid-run, persisted so the UI can render
 * the quiz and the run can resume once answered. A permission boundary is the
 * degenerate case (two options, `permission` set).
 */
export interface AgentQuestion {
  id: string;
  runId: string;
  taskId: string;
  header: string;
  question: string;
  /** Choices, or null for a free-text answer. */
  options: AgentQuestionOption[] | null;
  multiSelect: boolean;
  /** Set when the question came from a tool-permission boundary. */
  permission: { toolName: string; toolInput: unknown } | null;
  /** Null until the human answers. */
  answer: AgentQuestionAnswer | null;
  askedAt: Timestamp;
  answeredAt: Timestamp | null;
}

/** Validate an answer against a question's shape. Returns an error string or null. */
export function validateAnswer(
  question: Pick<AgentQuestion, 'options' | 'multiSelect'>,
  answer: AgentQuestionAnswer,
): string | null {
  if ('text' in answer) {
    if (question.options) return 'this question expects a selection, not free text';
    return typeof answer.text === 'string' ? null : 'text answer must be a string';
  }
  if (!question.options) return 'this question expects free text, not a selection';
  if (!Array.isArray(answer.selected) || answer.selected.length === 0) {
    return 'select at least one option';
  }
  if (!question.multiSelect && answer.selected.length > 1) {
    return 'this question allows only one selection';
  }
  const labels = new Set(question.options.map((o) => o.label));
  const unknown = answer.selected.find((s) => !labels.has(s));
  return unknown ? `unknown option: ${unknown}` : null;
}
