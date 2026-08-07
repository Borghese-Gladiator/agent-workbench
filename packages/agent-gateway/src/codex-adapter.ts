import type { ModelUsage } from '@awb/domain';
import type { AgentEventSink } from './adapter.js';
import {
  boundedSummary,
  CliStreamAdapter,
  type CliArgvContext,
  type CliStreamAccumulator,
  type RunCliStreaming,
} from './cli-runtime.js';

export interface CodexAdapterOptions {
  runCliStreaming?: RunCliStreaming;
  /** Path/name of the `codex` binary. Default `codex` (resolved on PATH). */
  bin?: string;
  /** Model id to run on. Omit to use Codex's own default. */
  model?: string;
  stallTimeoutMs?: number;
}

/**
 * `CodingAgentAdapter` backed by the `codex` CLI in non-interactive JSONL mode
 * (`codex exec --json`). Plugs in behind the same contract as the Claude/mock adapters via the
 * shared {@link CliStreamAdapter} base, which owns spawn/kill/watchdog/session lifecycle; this file
 * only supplies Codex's argv + its JSONL event schema (codex-cli 0.142.x).
 */
export class CodexAgentAdapter extends CliStreamAdapter {
  readonly id = 'codex';
  protected readonly defaultBin = 'codex';

  constructor(opts: CodexAdapterOptions = {}) {
    super(opts);
  }

  protected buildArgv(ctx: CliArgvContext): string[] {
    // `--skip-git-repo-check`: exec refuses to run in a dir codex hasn't trusted; task worktrees are
    // never in that list. `project_doc_max_bytes=0` keeps AGENTS.md discovery off — the caller inlines
    // exactly the context it wants. `--sandbox workspace-write` lets the agent edit inside the cwd.
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'project_doc_max_bytes=0'];
    if (this.model) args.push('--model', this.model);
    // Resume threads the prior thread id; the prompt is the next turn. Cold start passes the prompt.
    if (ctx.resumeSessionId) args.push('resume', ctx.resumeSessionId, ctx.prompt);
    else args.push(ctx.prompt);
    return args;
  }

  protected consumeLine(line: string, acc: CliStreamAccumulator, eventSink: AgentEventSink): void {
    consumeCodexStreamLine(line, acc, eventSink);
  }
}

/** The `usage` object on `turn.completed` (codex-cli, snake_case). */
function codexUsage(usage: unknown): ModelUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, number | undefined>;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  if (input === 0 && output === 0) return undefined;
  return {
    provider: 'openai',
    model: 'codex',
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: u.cached_input_tokens,
  };
}

/**
 * Parse one JSONL line from `codex exec --json`, emitting neutral `AgentEvent`s and accumulating
 * terminal state. Observed schema: top-level `type` ∈ {thread.started, turn.started, item.started,
 * item.updated, item.completed, turn.completed, turn.failed, error}, with `item.type` ∈
 * {agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, ...}.
 */
export function consumeCodexStreamLine(line: string, acc: CliStreamAccumulator, eventSink: AgentEventSink): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  switch (msg.type) {
    case 'thread.started': {
      if (typeof msg.thread_id === 'string' && !acc.sessionId) acc.sessionId = msg.thread_id;
      return;
    }
    case 'item.completed': {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return;
      if (item.item_type === 'agent_message' || item.type === 'agent_message') {
        const text = typeof item.text === 'string' ? item.text : '';
        if (text) {
          acc.finalText += text;
          eventSink({ type: 'message', text });
        }
      } else if (item.item_type === 'command_execution' || item.type === 'command_execution') {
        eventSink({ type: 'tool-completed', tool: 'command_execution', resultSummary: boundedSummary(item.aggregated_output ?? item.command) });
      } else if (item.item_type === 'file_change' || item.type === 'file_change') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        for (const change of changes) {
          const path = (change as { path?: unknown })?.path;
          if (typeof path === 'string') eventSink({ type: 'file-changed', path });
        }
      }
      return;
    }
    case 'item.started': {
      const item = msg.item as Record<string, unknown> | undefined;
      const itemType = item?.item_type ?? item?.type;
      if (itemType === 'command_execution') {
        eventSink({ type: 'tool-started', tool: 'command_execution', inputSummary: boundedSummary(item?.command) });
      } else if (itemType === 'mcp_tool_call') {
        eventSink({ type: 'tool-started', tool: String(item?.server ?? 'mcp'), inputSummary: boundedSummary(item?.tool) });
      }
      return;
    }
    case 'turn.completed': {
      const usage = codexUsage(msg.usage);
      if (usage) acc.usage = usage;
      return;
    }
    case 'turn.failed': {
      const error = msg.error as { message?: unknown } | undefined;
      acc.errorMessage = typeof error?.message === 'string' ? error.message : 'turn failed';
      return;
    }
    case 'error': {
      if (typeof msg.message === 'string') acc.errorMessage = msg.message;
      return;
    }
    default:
      return;
  }
}
