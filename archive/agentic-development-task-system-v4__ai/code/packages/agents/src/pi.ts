/**
 * PiAgentRuntimeAdapter — runs a real coding agent for one lifecycle stage by
 * shelling out to the locally-installed `pi` CLI (Pi Coding Agent) in JSON event
 * mode (`pi --mode json -p ...`). It is the second concrete `AgentRuntimeAdapter`
 * alongside the Claude adapter and plugs in behind the SAME contract, so the
 * daemon never changes.
 *
 * Shape mirrors the Claude adapter on purpose: same worktree confinement, same
 * shared spawn runners (own process group + stall/abort watchdog + pgid capture
 * from `run-shared.ts`), same `StreamEvent` payloads (so the SSE terminal and
 * profiling work unchanged), and the same `AgentRunResult` with a `sessionId`
 * for `--session` resume.
 *
 * Differences from Claude, by design:
 * - Tool policy maps to Pi's tool surface via {@link mapPolicyToPi} (`--tools` /
 *   `--exclude-tools`). The capability boundary is enforced structurally — a tool
 *   not granted simply does not exist for the run.
 * - The mid-run human question gate is NOT wired: `pi --mode json` has no
 *   permission-prompt MCP relay. Pi runs ungated; `handlers.requestInput` is
 *   never called. Pi's surface also has no Task/Monitor/Skill escape tools, so
 *   the escape-deny boundary is satisfied by the closed allowlist.
 * - Pi reports no single cost/USD line on the JSON stream, so cost is null and
 *   token usage is aggregated from per-turn `usage` objects.
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
  mapPolicyToPi,
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

/** 10-minute stall watchdog: matches the Claude adapter. */
const DEFAULT_STALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface PiAdapterOptions {
  /** Override the streaming CLI runner — primarily for tests. */
  runCliStreaming?: RunCliStreaming;
  /** Path/name of the `pi` binary. Default `pi` (resolved on PATH). */
  bin?: string;
  /** Model id/pattern to run on (e.g. 'claude-opus-4-5'). Omit to use Pi's default. */
  model?: string;
  /** Fail a streaming run after this long with zero stream activity. 0 disables. */
  stallTimeoutMs?: number;
}

/** Map the workbench `Effort` flag onto Pi's `--thinking` levels. */
function thinkingFor(effort: Effort | undefined): string | undefined {
  if (!effort) return undefined;
  // Pi accepts off/minimal/low/medium/high/xhigh. The workbench `max` has no Pi
  // peer above xhigh, so it clamps there; the rest pass through 1:1.
  return effort === ('max' as Effort) ? 'xhigh' : (effort as unknown as string);
}

export class PiAgentRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly runCliStreaming: RunCliStreaming;
  private readonly bin: string;
  private readonly model?: string;
  private readonly stallTimeoutMs: number;

  constructor(opts: PiAdapterOptions = {}) {
    this.runCliStreaming = opts.runCliStreaming ?? defaultRunCliStreaming;
    this.bin = opts.bin ?? 'pi';
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
        error: 'pi adapter requires a task worktree (no worktreePath provided)',
      };
    }

    const policy = mapPolicyToPi(policyForStage(input.stage));
    // Resume mode (rejection redo): the session holds the full prior context, so
    // we send ONLY the reviewer's comment as this turn — not the stage packet.
    const prompt = input.resume
      ? input.resume.message
      : (input.promptOverride ?? assembleStagePrompt(input));
    capturePromptToDisk(input, prompt);

    // `pi` has no turn-cap flag (confirmed: `--max-turns` is rejected as an
    // unknown option). The run is bounded by the stall watchdog below instead.
    const args = ['--mode', 'json', '-p', prompt];
    // Resume the prior session: Pi continues it and reads the comment as the next
    // turn. `--no-context-files` keeps AGENTS.md/CLAUDE.md discovery off — the
    // daemon inlines exactly the context it wants into the prompt.
    if (input.resume) args.push('--session', input.resume.sessionId);
    args.push('--no-context-files');
    if (policy.tools.length) args.push('--tools', policy.tools.join(','));
    if (policy.excludeTools.length) args.push('--exclude-tools', policy.excludeTools.join(','));
    args.push(
      '--append-system-prompt',
      // Pi's tool surface has no escape/orchestration tools to probe for, so pass
      // the run's own (Pi-named) tool list and an empty probe set.
      stageSystemPrompt({ allowedTools: policy.tools, stage: input.stage, probeTools: [] }),
    );
    const model = input.model ?? this.model;
    if (model) args.push('--model', model);
    const thinking = thinkingFor(input.effort);
    if (thinking) args.push('--thinking', thinking);

    const acc = newPiAccumulator();

    // Stall watchdog + external stop, identical wiring to the Claude adapter.
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
          consumePiStreamLine(line, acc, handlers);
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
          error: `pi run did not succeed (${message})`,
          sessionId: acc.sessionId,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      handlers.onEvent({ type: 'error', payload: { message } });
      return {
        status: 'failed',
        transcript: transcriptArtifact(input, this.bin, args, { note: `spawn failed: ${message}` }),
        produced: [],
        error: `failed to run pi CLI: ${message}`,
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
        error: `pi run did not succeed (${message})`,
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
        error: `pi run did not succeed (${message})`,
        sessionId: acc.sessionId,
      };
    }

    // A non-zero exit, a stream-level error, or no output at all = failure.
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
        error: `pi run did not succeed (${reason})`,
        sessionId: acc.sessionId,
      };
    }

    const kind: ArtifactKind = isAgentStage(input.stage) ? STAGE_TO_ARTIFACT[input.stage] : 'log';
    const produced = buildProduced(kind, input.stage, acc.finalText, input.repoProfile);
    return { status: 'succeeded', transcript, produced, sessionId: acc.sessionId };
  }
}

/* ------------------------------------------------------------------ *
 *  Pi NDJSON stream parsing                                          *
 * ------------------------------------------------------------------ */

/** Terminal state accumulated across Pi stream lines (one per streaming run). */
export interface PiStreamAccumulator {
  finalText: string;
  turns: number;
  sessionId?: string;
  errorMessage?: string;
  usage: TokenUsage;
  /** Per-turn TTFT tracking (see the Claude accumulator). */
  turnIndex: number;
  turnBoundaryMs: number | null;
  firstTokenMs: number | null;
  awaitingFirstToken: boolean;
}

/** Factory for a fresh Pi accumulator (run start state). Exported for tests. */
export function newPiAccumulator(): PiStreamAccumulator {
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

/** Pull Pi's per-turn `usage` (Anthropic Messages shape) onto the core TokenUsage. */
function piTurnUsage(message: unknown): TokenUsage | null {
  const usage = (message as { usage?: Record<string, number> } | undefined)?.usage;
  if (!usage) return null;
  // Pi's `usage` is camelCase (`input`/`output`/`cacheRead`/`cacheWrite`),
  // verified against pi 0.80.2 — NOT the Anthropic Messages snake_case. Accept
  // the snake_case spelling too as a fallback for other providers.
  const pick = (camel: string, snake: string) => usage[camel] ?? usage[snake] ?? null;
  return {
    inputTokens: pick('input', 'input_tokens'),
    outputTokens: pick('output', 'output_tokens'),
    cacheCreationInputTokens: pick('cacheWrite', 'cache_creation_input_tokens'),
    cacheReadInputTokens: pick('cacheRead', 'cache_read_input_tokens'),
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

/** Bound a tool-result content to a short string summary for an event payload. */
function boundedSummary(content: unknown): string {
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((c) =>
        typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : '',
      )
      .join('');
  } else text = JSON.stringify(content ?? '');
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * Parse one NDJSON line from `pi --mode json` and emit the relevant
 * `StreamEvent`s (same payloads as the Claude adapter), accumulating terminal
 * state. Event schema per Pi's json docs: top-level `type` ∈ {session,
 * agent_start, turn_start, message_update, message_end, tool_execution_start,
 * tool_execution_end, turn_end, agent_end, auto_retry_end, ...}.
 */
export function consumePiStreamLine(
  line: string,
  acc: PiStreamAccumulator,
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
  const type = msg.type;

  switch (type) {
    case 'session': {
      if (typeof msg.id === 'string' && !acc.sessionId) acc.sessionId = msg.id;
      return;
    }
    case 'turn_start': {
      // Open a turn: count it, emit the `turn` event with the TTFT measured from
      // the boundary (run start, or the prior tool result) to first token.
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
    case 'message_update': {
      // The first model emission of a turn is the true first token.
      if (acc.awaitingFirstToken) {
        acc.firstTokenMs = now();
        acc.awaitingFirstToken = false;
      }
      const ev = msg.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
        acc.finalText += ev.delta;
        handlers.onEvent({ type: 'assistant_text', payload: { text: ev.delta } });
      }
      return;
    }
    case 'tool_execution_start': {
      handlers.onEvent({
        type: 'tool_call',
        payload: { name: msg.toolName, input: msg.args },
      });
      return;
    }
    case 'tool_execution_end': {
      // A tool result opens the NEXT turn: reset the boundary + re-arm first-token.
      acc.turnBoundaryMs = now();
      acc.firstTokenMs = null;
      acc.awaitingFirstToken = true;
      handlers.onEvent({
        type: 'tool_result',
        payload: { status: msg.isError ? 'error' : 'ok', summary: boundedSummary(msg.result) },
      });
      return;
    }
    case 'turn_end': {
      const turnUsage = piTurnUsage(msg.message);
      if (turnUsage) addUsage(acc.usage, turnUsage);
      return;
    }
    case 'auto_retry_end': {
      // A failed final retry carries the terminal error.
      if (msg.success === false && typeof msg.finalError === 'string') {
        acc.errorMessage = msg.finalError;
      }
      return;
    }
    case 'agent_end': {
      // Pi has no single cost/USD line; emit aggregated usage with cost null so
      // the daemon's profiling fields populate (TTFT/turns/tokens) consistently.
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
      return;
    }
    default:
      // error / queue_update / compaction_* / message_start|end — capture a
      // top-level error message if present; otherwise ignore.
      if (type === 'error' && typeof msg.message === 'string') {
        acc.errorMessage = msg.message;
        handlers.onEvent({ type: 'error', payload: { message: msg.message } });
      }
  }
}

/* ------------------------------------------------------------------ *
 *  Artifact builders (Pi-labeled)                                    *
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
  const policy = mapPolicyToPi(policyForStage(input.stage));
  const redactedArgs = args.map((a, i) => (args[i - 1] === '-p' ? '<stage-packet>' : a));

  const header = [
    `# Agent Transcript (pi CLI)`,
    ``,
    `Task: ${input.taskTitle}`,
    `Stage: ${input.stage}`,
    `Worktree (cwd): ${input.worktreePath ?? '(none)'}`,
    `Allowed tools: ${policy.tools.join(', ') || '(none)'}`,
    `Excluded tools: ${policy.excludeTools.join(', ') || '(none)'}`,
    `Context artifacts: ${input.contextArtifactIds.join(', ') || '(none)'}`,
    meta.note ? `Note: ${meta.note}` : null,
    meta.error ? `Error: ${meta.error}` : null,
    meta.exitCode !== undefined ? `Exit code: ${meta.exitCode}` : null,
    meta.turns !== undefined ? `Turns: ${meta.turns}` : null,
    ``,
    `## Invocation`,
    ``,
    '```',
    `${bin} ${redactedArgs.join(' ')}`,
    '```',
    ``,
  ].filter((l): l is string => l !== null);

  const tail: string[] = [];
  if (meta.result) tail.push(`## Final output`, ``, meta.result, ``);
  if (meta.stderr?.trim()) tail.push(`## stderr`, ``, '```', meta.stderr.trim(), '```', ``);

  return {
    kind: 'log',
    title: `Agent run (pi) — ${input.stage}`,
    body: [...header, ...tail].join('\n'),
  };
}

/**
 * Build the produced stage artifact from the final text. Mirrors the Claude
 * adapter: parse the fenced json block, verify skill compliance, prepend a
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
  const title = `${stage} (pi)`;
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
 *  Diagnostic prompt capture (mirrors the Claude adapter)            *
 * ------------------------------------------------------------------ */

let captureSeq = 0;
function capturePromptToDisk(input: AgentRunInput, prompt: string): void {
  const dir = process.env.WORKBENCH_CAPTURE_PROMPTS;
  if (!dir) return;
  try {
    const file = join(dir, `${String(captureSeq++).padStart(3, '0')}-${input.stage}.pi.txt`);
    mkdirSync(dirname(file), { recursive: true });
    const head = `# stage=${input.stage} mode=${input.resume ? 'resume-turn' : 'packet'} ctx=${input.contextArtifactIds.join(',') || '(none)'}\n\n`;
    appendFileSync(file, head + prompt + '\n');
  } catch {
    /* capture is best-effort diagnostics — never break a run over it */
  }
}
