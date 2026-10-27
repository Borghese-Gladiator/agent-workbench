/**
 * CodexAgentRuntimeAdapter — runs a real coding agent for one lifecycle stage by
 * shelling out to the locally-installed `codex` CLI (OpenAI Codex) in JSONL
 * event mode (`codex exec --json ...`). Third concrete `AgentRuntimeAdapter`
 * alongside Claude and Pi, behind the SAME contract, so the daemon never changes.
 *
 * Shape mirrors the Pi adapter: same worktree confinement, same shared spawn
 * runners (own process group + stall/abort watchdog + pgid capture from
 * `run-shared.ts`), same `StreamEvent` payloads, and the same `AgentRunResult`
 * with a `sessionId` (Codex thread id) for `codex exec resume`.
 *
 * Differences from Claude/Pi, by design:
 * - Tool policy maps to SANDBOX MODES via {@link mapPolicyToCodex} — Codex has
 *   no per-tool allow/exclude lists. `read-only` lets commands run but blocks
 *   writes; `workspace-write` allows mutation inside the cwd.
 * - No mid-run human gate: `codex exec` is non-interactive.
 * - No `--append-system-prompt`: the stage system prompt is PREPENDED to the
 *   packet on fresh runs (resume turns send only the message — the thread
 *   already carries it).
 * - Verified live against codex-cli 0.142.5: `--skip-git-repo-check` is
 *   required outside codex-trusted directories, the CLI reads stdin when
 *   attached (run-shared spawns with stdin ignored), and a user-config
 *   deprecation surfaces as a non-fatal `item.type: "error"` event mid-stream
 *   on runs that still exit 0 — so error ITEMS must not fail the run.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ArtifactKind, TokenUsage } from '@workbench/core';
import { detectEmptyArtifact } from './claude.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  ProducedArtifact,
  StreamHandlers,
} from './index.js';
import {
  assembleStagePrompt,
  bufferingHandlers,
  type Effort,
  isAgentStage,
  mapPolicyToCodex,
  policyForStage,
  STAGE_TO_ARTIFACT,
  stageSystemPrompt,
  verifyRepoSkillCompliance,
} from './index.js';
import {
  type CliStreamResult,
  defaultRunCliStreaming,
  extractJsonBlock,
  type RunCliStreaming,
} from './run-shared.js';

/** 10-minute stall watchdog: matches the Claude and Pi adapters. */
const DEFAULT_STALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface CodexAdapterOptions {
  /** Override the streaming CLI runner — primarily for tests. */
  runCliStreaming?: RunCliStreaming;
  /** Path/name of the `codex` binary. Default `codex` (resolved on PATH). */
  bin?: string;
  /** Model id (e.g. 'gpt-5.2-codex'). Omit to use Codex's configured default. */
  model?: string;
  /** Fail a streaming run after this long with zero stream activity. 0 disables. */
  stallTimeoutMs?: number;
}

/**
 * Map the workbench `Effort` onto Codex's `model_reasoning_effort` values
 * (minimal/low/medium/high/xhigh). `max` has no Codex peer above xhigh, so it
 * clamps there; the rest pass through 1:1.
 */
function reasoningEffortFor(effort: Effort | undefined): string | undefined {
  if (!effort) return undefined;
  return effort === ('max' as Effort) ? 'xhigh' : (effort as unknown as string);
}

/**
 * The tool names shown to the model in the stage system prompt. Codex's policy
 * surface is the sandbox, not tool lists, so this names its REAL built-in
 * surface for the granted capabilities rather than pretending to a per-tool
 * boundary that doesn't exist.
 */
function promptToolNames(policy: ReturnType<typeof mapPolicyToCodex>): string[] {
  const tools = ['shell' + (policy.sandbox === 'read-only' ? ' (read-only sandbox)' : '')];
  if (policy.sandbox === 'workspace-write') tools.push('apply_patch');
  if (policy.webSearch) tools.push('web_search');
  return tools;
}

export class CodexAgentRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly runCliStreaming: RunCliStreaming;
  private readonly bin: string;
  private readonly model?: string;
  private readonly stallTimeoutMs: number;

  constructor(opts: CodexAdapterOptions = {}) {
    this.runCliStreaming = opts.runCliStreaming ?? defaultRunCliStreaming;
    this.bin = opts.bin ?? 'codex';
    this.model = opts.model;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  }

  /** One-shot run: drive the streaming path with buffering handlers. */
  async runStageAgent(input: AgentRunInput): Promise<AgentRunResult> {
    return this.streamStageAgent(input, bufferingHandlers());
  }

  async streamStageAgent(input: AgentRunInput, handlers: StreamHandlers): Promise<AgentRunResult> {
    // Confinement: never run without a worktree to run *inside*.
    if (!input.worktreePath) {
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, [], {
          note: 'aborted: no worktree path — refusing to run',
        }),
        produced: [],
        error: 'codex adapter requires a task worktree (no worktreePath provided)',
      };
    }

    const policy = mapPolicyToCodex(policyForStage(input.stage));
    // Resume mode (rejection redo): the thread holds the full prior context, so
    // send ONLY the reviewer's comment as this turn — not the stage packet.
    const packet = input.resume
      ? input.resume.message
      : (input.promptOverride ?? assembleStagePrompt(input));
    // Fresh runs carry the stage system prompt inline (no append flag on exec).
    const prompt = input.resume
      ? packet
      : `${stageSystemPrompt({ allowedTools: promptToolNames(policy), stage: input.stage, probeTools: [] })}\n\n---\n\n${packet}`;
    capturePromptToDisk(input, prompt);

    // `--skip-git-repo-check`: exec refuses to run in a directory codex hasn't
    // trusted; task worktrees under the daemon data dir are never in that list.
    // `project_doc_max_bytes=0` keeps AGENTS.md discovery off — the daemon
    // inlines exactly the context it wants (parity with pi --no-context-files).
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', policy.sandbox];
    args.push('-c', 'project_doc_max_bytes=0');
    if (policy.webSearch) args.push('-c', 'tools.web_search=true');
    const model = input.model ?? this.model;
    if (model) args.push('--model', model);
    const effort = reasoningEffortFor(input.effort);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    if (input.resume) args.push('resume', input.resume.sessionId, prompt);
    else args.push(prompt);

    const acc = newCodexAccumulator();

    // Stall watchdog + external stop, identical wiring to the Pi adapter.
    const watchdog = new AbortController();
    let lastActivity = Date.now();
    let stalled = false;
    let stopped = false;
    if (input.signal) {
      if (input.signal.aborted) {
        stopped = true;
        watchdog.abort();
      } else {
        input.signal.addEventListener(
          'abort',
          () => {
            stopped = true;
            watchdog.abort();
          },
          { once: true },
        );
      }
    }
    const checker =
      this.stallTimeoutMs > 0
        ? setInterval(
            () => {
              if (Date.now() - lastActivity > this.stallTimeoutMs) {
                stalled = true;
                watchdog.abort();
              }
            },
            Math.min(this.stallTimeoutMs, 15_000),
          )
        : undefined;

    acc.turnBoundaryMs = Date.now();

    let stream: CliStreamResult;
    try {
      stream = await this.runCliStreaming(
        { bin: this.bin, args, cwd: input.worktreePath, env: input.env, signal: watchdog.signal },
        (line) => {
          lastActivity = Date.now();
          consumeCodexStreamLine(line, acc, handlers);
        },
        handlers.onSpawn,
      );
    } catch (err) {
      if (stopped) {
        const message = 'stopped by operator';
        handlers.onEvent({ type: 'error', payload: { message } });
        return {
          status: 'failed',
          transcript: transcriptArtifact(input, this.bin, args, { note: message }),
          produced: [],
          error: `codex run did not succeed (${message})`,
          sessionId: acc.sessionId,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      handlers.onEvent({ type: 'error', payload: { message } });
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, args, { note: `spawn failed: ${message}` }),
        produced: [],
        error: `failed to run codex CLI: ${message}`,
      };
    } finally {
      if (checker) clearInterval(checker);
    }

    if (stopped) {
      const message = 'stopped by operator';
      handlers.onEvent({ type: 'error', payload: { message } });
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, args, { note: message }),
        produced: [],
        error: `codex run did not succeed (${message})`,
        sessionId: acc.sessionId,
      };
    }
    if (stalled) {
      const message = `stalled: no stream activity for ${this.stallTimeoutMs}ms — killed`;
      handlers.onEvent({ type: 'error', payload: { message } });
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, args, { note: message }),
        produced: [],
        error: `codex run did not succeed (${message})`,
        sessionId: acc.sessionId,
      };
    }

    // Codex has no terminal agent_end event: emit the aggregate cost + result
    // events after the stream closes (cost is null — usage-only, like Pi).
    handlers.onEvent({
      type: 'cost',
      payload: {
        totalCostUsd: null,
        numTurns: acc.turns || null,
        durationMs: null,
        durationApiMs: null,
        ...acc.usage,
      },
    });
    handlers.onEvent({
      type: 'result',
      payload: {
        subtype: acc.errorMessage ? 'error' : 'success',
        isError: Boolean(acc.errorMessage),
        denials: [],
      },
    });

    // A non-zero exit, a failed turn, or no output at all = failure. Non-fatal
    // `item.type: "error"` notices (e.g. config deprecations) do NOT fail a run.
    const failed = stream.code !== 0 || Boolean(acc.errorMessage) || acc.finalText.trim() === '';

    const transcript = transcriptArtifact(input, this.bin, args, {
      result: acc.finalText,
      turns: acc.turns,
      exitCode: stream.code,
      stderr: stream.stderr,
      error: acc.errorMessage,
    });

    if (failed) {
      const reason = acc.errorMessage
        ? `error: ${acc.errorMessage}`
        : acc.finalText.trim() === ''
          ? 'empty output'
          : `exit ${stream.code}`;
      return {
        status: 'failed',
        transcript,
        produced: [],
        error: `codex run did not succeed (${reason})`,
        sessionId: acc.sessionId,
      };
    }

    const kind: ArtifactKind = isAgentStage(input.stage) ? STAGE_TO_ARTIFACT[input.stage] : 'log';
    const produced = buildProduced(kind, input.stage, acc.finalText, input.repoProfile);
    return { status: 'succeeded', transcript, produced, sessionId: acc.sessionId };
  }
}

/* ------------------------------------------------------------------ *
 *  Codex JSONL stream parsing                                        *
 * ------------------------------------------------------------------ */

/** Terminal state accumulated across Codex stream lines (one per streaming run). */
export interface CodexStreamAccumulator {
  finalText: string;
  turns: number;
  sessionId?: string;
  /** Fatal only: turn.failed / top-level error. Item-level errors don't land here. */
  errorMessage?: string;
  usage: TokenUsage;
  /** Per-turn TTFT tracking (see the Pi accumulator). */
  turnIndex: number;
  turnBoundaryMs: number | null;
  firstTokenMs: number | null;
  awaitingFirstToken: boolean;
}

/** Factory for a fresh Codex accumulator (run start state). Exported for tests. */
export function newCodexAccumulator(): CodexStreamAccumulator {
  return {
    finalText: '',
    turns: 0,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    },
    turnIndex: 0,
    turnBoundaryMs: null,
    firstTokenMs: null,
    awaitingFirstToken: true,
  };
}

/** Add a turn's usage into the run total (nulls treated as 0 once any value seen). */
function addUsage(acc: TokenUsage, turn: TokenUsage): void {
  const sum = (a: number | null, b: number | null) =>
    a == null && b == null ? null : (a ?? 0) + (b ?? 0);
  acc.inputTokens = sum(acc.inputTokens, turn.inputTokens);
  acc.outputTokens = sum(acc.outputTokens, turn.outputTokens);
  acc.cacheCreationInputTokens = sum(acc.cacheCreationInputTokens, turn.cacheCreationInputTokens);
  acc.cacheReadInputTokens = sum(acc.cacheReadInputTokens, turn.cacheReadInputTokens);
}

/** Bound arbitrary content to a short string summary for an event payload. */
function boundedSummary(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** The `usage` object on `turn.completed` (codex-cli 0.142.5, snake_case). */
function codexTurnUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, number | undefined>;
  return {
    inputTokens: u.input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: u.cached_input_tokens ?? null,
  };
}

/**
 * Parse one JSONL line from `codex exec --json` and emit the relevant
 * `StreamEvent`s (same payloads as the Claude/Pi adapters), accumulating
 * terminal state. Event schema observed live on codex-cli 0.142.5: top-level
 * `type` ∈ {thread.started, turn.started, item.started, item.updated,
 * item.completed, turn.completed, turn.failed, error}, with `item.type` ∈
 * {agent_message, reasoning, command_execution, file_change, mcp_tool_call,
 * web_search, error, todo_list}.
 */
export function consumeCodexStreamLine(
  line: string,
  acc: CodexStreamAccumulator,
  handlers: StreamHandlers,
  now: () => number = Date.now,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return; // ignore non-JSON noise
  }

  switch (msg.type) {
    case 'thread.started': {
      if (typeof msg.thread_id === 'string' && !acc.sessionId) acc.sessionId = msg.thread_id;
      return;
    }
    case 'turn.started': {
      acc.turnIndex += 1;
      acc.turns = acc.turnIndex;
      if (acc.firstTokenMs == null) {
        acc.firstTokenMs = now();
        acc.awaitingFirstToken = false;
      }
      const ttftMs =
        acc.turnBoundaryMs != null && acc.firstTokenMs != null
          ? Math.max(0, acc.firstTokenMs - acc.turnBoundaryMs)
          : null;
      handlers.onEvent({ type: 'turn', payload: { index: acc.turnIndex, ttftMs } });
      return;
    }
    case 'item.started': {
      if (acc.awaitingFirstToken) {
        acc.firstTokenMs = now();
        acc.awaitingFirstToken = false;
      }
      const item = msg.item as Record<string, unknown> | undefined;
      if (item?.type === 'command_execution') {
        handlers.onEvent({
          type: 'tool_call',
          payload: { name: 'shell', input: { command: item.command } },
        });
      }
      return;
    }
    case 'item.completed': {
      if (acc.awaitingFirstToken) {
        acc.firstTokenMs = now();
        acc.awaitingFirstToken = false;
      }
      const item = msg.item as Record<string, unknown> | undefined;
      switch (item?.type) {
        case 'agent_message': {
          if (typeof item.text === 'string' && item.text) {
            acc.finalText += (acc.finalText ? '\n\n' : '') + item.text;
            handlers.onEvent({ type: 'assistant_text', payload: { text: item.text } });
          }
          return;
        }
        case 'command_execution': {
          // A finished command opens the NEXT turn boundary (see Pi).
          acc.turnBoundaryMs = now();
          acc.firstTokenMs = null;
          acc.awaitingFirstToken = true;
          handlers.onEvent({
            type: 'tool_result',
            payload: {
              status: item.exit_code === 0 ? 'ok' : 'error',
              summary: boundedSummary(item.aggregated_output),
            },
          });
          return;
        }
        case 'file_change': {
          handlers.onEvent({
            type: 'tool_call',
            payload: { name: 'apply_patch', input: { changes: item.changes } },
          });
          handlers.onEvent({
            type: 'tool_result',
            payload: {
              status: item.status === 'failed' ? 'error' : 'ok',
              summary: boundedSummary(item.changes),
            },
          });
          return;
        }
        case 'mcp_tool_call':
        case 'web_search': {
          handlers.onEvent({
            type: 'tool_call',
            payload: { name: String(item.type), input: item },
          });
          return;
        }
        case 'error': {
          // NON-fatal notice (observed live: a user-config deprecation streams
          // as an error item on a run that exits 0). Surface it, don't fail on it.
          if (typeof item.message === 'string') {
            handlers.onEvent({ type: 'error', payload: { message: item.message } });
          }
          return;
        }
        default:
          return; // reasoning / todo_list / unknown — ignore
      }
    }
    case 'turn.completed': {
      const turnUsage = codexTurnUsage(msg.usage);
      if (turnUsage) addUsage(acc.usage, turnUsage);
      return;
    }
    case 'turn.failed': {
      const err = msg.error as { message?: unknown } | undefined;
      const message = typeof err?.message === 'string' ? err.message : 'turn failed';
      acc.errorMessage = message;
      handlers.onEvent({ type: 'error', payload: { message } });
      return;
    }
    default:
      if (msg.type === 'error' && typeof msg.message === 'string') {
        acc.errorMessage = msg.message;
        handlers.onEvent({ type: 'error', payload: { message: msg.message } });
      }
  }
}

/* ------------------------------------------------------------------ *
 *  Artifact builders (Codex-labeled)                                 *
 * ------------------------------------------------------------------ */

/** Build the transcript artifact body (a `log`). */
function transcriptArtifact(
  input: AgentRunInput,
  bin: string,
  args: string[],
  meta: {
    result?: string;
    turns?: number;
    exitCode?: number | null;
    stderr?: string;
    note?: string;
    error?: string;
  } = {},
): ProducedArtifact {
  const policy = mapPolicyToCodex(policyForStage(input.stage));
  // The prompt is the last positional arg (fresh AND resume paths).
  const promptIdx = args.length - 1;
  const redactedArgs = args.map((a, i) => (i === promptIdx ? '<stage-packet>' : a));

  const header = [
    `# Agent Transcript (codex CLI)`,
    ``,
    `Task: ${input.taskTitle}`,
    `Stage: ${input.stage}`,
    `Worktree (cwd): ${input.worktreePath ?? '(none)'}`,
    `Sandbox: ${policy.sandbox}`,
    `Web search: ${policy.webSearch ? 'on' : 'off'}`,
    `Context artifacts: ${input.contextArtifactIds.join(', ') || '(none)'}`,
    meta.note ? `Note: ${meta.note}` : null,
    meta.error ? `Error: ${meta.error}` : null,
    meta.exitCode !== undefined ? `Exit code: ${meta.exitCode}` : null,
    meta.turns !== undefined ? `Turns: ${meta.turns}` : null,
    ``,
    `## Invocation`,
    ``,
    '```',
    `${bin} ${args.length ? redactedArgs.join(' ') : '(not spawned)'}`,
    '```',
    ``,
  ].filter((l): l is string => l !== null);

  const tail: string[] = [];
  if (meta.result) tail.push(`## Final output`, ``, meta.result, ``);
  if (meta.stderr?.trim()) tail.push(`## stderr`, ``, '```', meta.stderr.trim(), '```', ``);

  return {
    kind: 'log',
    title: `Agent run (codex) — ${input.stage}`,
    body: [...header, ...tail].join('\n'),
  };
}

/**
 * Build the produced stage artifact from the final text. Mirrors the Claude/Pi
 * adapters: parse the fenced json block, verify skill compliance, prepend a
 * non-fatal banner when the artifact looks empty or fails compliance, and store
 * the agent's prose verbatim.
 */
function buildProduced(
  kind: ArtifactKind,
  stage: string,
  finalText: string,
  repoProfile?: string,
): ProducedArtifact[] {
  const structured = extractJsonBlock(finalText);
  const title = `${stage} (codex)`;
  const warning = verifyRepoSkillCompliance(repoProfile ?? null, stage, structured);
  const emptiness = detectEmptyArtifact(stage, finalText, structured);
  const banner = [
    ...(emptiness ? [`> ⚠️ **Artifact looks empty/unstructured:** ${emptiness}`, ``] : []),
    ...(warning ? [`> ⚠️ **Skill compliance:** ${warning}`, ``] : []),
  ];
  const body = [...banner, finalText || '(empty agent output)'].join('\n');
  return [{ kind, title, body }];
}

/* ------------------------------------------------------------------ *
 *  Diagnostic prompt capture (mirrors the Claude/Pi adapters)        *
 * ------------------------------------------------------------------ */

let captureSeq = 0;
function capturePromptToDisk(input: AgentRunInput, prompt: string): void {
  const dir = process.env.WORKBENCH_CAPTURE_PROMPTS;
  if (!dir) return;
  try {
    const file = join(dir, `${String(captureSeq++).padStart(3, '0')}-${input.stage}.codex.txt`);
    mkdirSync(dirname(file), { recursive: true });
    const head = `# stage=${input.stage} mode=${input.resume ? 'resume-turn' : 'packet'} ctx=${input.contextArtifactIds.join(',') || '(none)'}\n\n`;
    appendFileSync(file, head + prompt + '\n');
  } catch {
    /* capture is best-effort diagnostics — never break a run over it */
  }
}
