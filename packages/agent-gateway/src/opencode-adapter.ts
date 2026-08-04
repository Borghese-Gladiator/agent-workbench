import type { ModelUsage } from '@awb/domain';
import type { AgentEventSink } from './adapter.js';
import {
  boundedSummary,
  CliStreamAdapter,
  type CliArgvContext,
  type CliStreamAccumulator,
  type RunCliStreaming,
} from './cli-runtime.js';

export interface OpenCodeAdapterOptions {
  runCliStreaming?: RunCliStreaming;
  /** Path/name of the `opencode` binary. Default `opencode` (resolved on PATH). */
  bin?: string;
  /** Model id in `provider/model` form (e.g. `anthropic/claude-sonnet-4-5`). Omit to use the default. */
  model?: string;
  stallTimeoutMs?: number;
}

/**
 * `CodingAgentAdapter` backed by the `opencode` CLI in non-interactive JSON mode
 * (`opencode run --format json`). `--dangerously-skip-permissions` auto-approves tools that are not
 * explicitly denied (the session is already confined to the task worktree + scoped by the caller).
 * Resume continues a prior session via `--session <id>`. Stream schema verified live against the
 * installed `opencode run --format json` (`step_start`/`text`/`tool_use`/`step_finish`).
 */
export class OpenCodeAgentAdapter extends CliStreamAdapter {
  readonly id = 'opencode';
  protected readonly defaultBin = 'opencode';

  constructor(opts: OpenCodeAdapterOptions = {}) {
    super(opts);
  }

  protected buildArgv(ctx: CliArgvContext): string[] {
    const args = ['run', '--format', 'json', '--dangerously-skip-permissions'];
    if (this.model) args.push('--model', this.model);
    if (ctx.resumeSessionId) args.push('--session', ctx.resumeSessionId);
    // The prompt is a positional message argument; pass it last so flags aren't swallowed.
    args.push(ctx.prompt);
    return args;
  }

  protected consumeLine(line: string, acc: CliStreamAccumulator, eventSink: AgentEventSink): void {
    consumeOpenCodeStreamLine(line, acc, eventSink);
  }
}

/** OpenCode's `part.tokens` on a `step_finish` event → a single ModelUsage (last step wins the total). */
function openCodeUsage(part: Record<string, unknown>): ModelUsage | undefined {
  const tokens = part.tokens as { input?: number; output?: number; cache?: { read?: number } } | undefined;
  if (!tokens) return undefined;
  const input = tokens.input ?? 0;
  const output = tokens.output ?? 0;
  if (input === 0 && output === 0) return undefined;
  return {
    provider: 'opencode',
    model: 'opencode',
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: tokens.cache?.read,
    costUsd: typeof part.cost === 'number' ? part.cost : undefined,
  };
}

/**
 * Parse one JSON line from `opencode run --format json`, emitting neutral `AgentEvent`s and
 * accumulating terminal state. Each line is `{ type, sessionID, part }`; `type` ∈ {step_start, text,
 * tool_use, step_finish}. `part.text` carries assistant text; `part.tool` + `part.state` carry a
 * tool call; `part.tokens`/`part.cost` land on `step_finish`.
 */
export function consumeOpenCodeStreamLine(line: string, acc: CliStreamAccumulator, eventSink: AgentEventSink): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  if (typeof msg.sessionID === 'string' && !acc.sessionId) acc.sessionId = msg.sessionID;
  const part = (msg.part as Record<string, unknown>) ?? {};

  switch (msg.type) {
    case 'text': {
      const text = typeof part.text === 'string' ? part.text : '';
      if (text) {
        acc.finalText += text;
        eventSink({ type: 'message', text });
      }
      return;
    }
    case 'tool_use': {
      const tool = typeof part.tool === 'string' ? part.tool : 'tool';
      const state = (part.state as Record<string, unknown>) ?? {};
      const status = state.status;
      if (status === 'completed' || status === 'error') {
        eventSink({ type: 'tool-completed', tool, resultSummary: boundedSummary(state.output ?? status) });
        // A file-editing tool completing is a changed path — surface it like the other adapters.
        const input = (state.input as Record<string, unknown>) ?? {};
        const path = input.filePath ?? input.path;
        if ((tool === 'write' || tool === 'edit' || tool === 'patch') && typeof path === 'string') {
          eventSink({ type: 'file-changed', path });
        }
      } else {
        eventSink({ type: 'tool-started', tool, inputSummary: boundedSummary(state.input) });
      }
      return;
    }
    case 'step_finish': {
      const usage = openCodeUsage(part);
      if (usage) acc.usage = usage;
      if (part.reason === 'error') acc.errorMessage = acc.errorMessage ?? 'step finished with error';
      return;
    }
    case 'error': {
      const err = (msg.error ?? part.error) as { message?: unknown } | undefined;
      if (typeof err?.message === 'string') acc.errorMessage = err.message;
      else if (typeof msg.message === 'string') acc.errorMessage = msg.message;
      return;
    }
    default:
      return;
  }
}
