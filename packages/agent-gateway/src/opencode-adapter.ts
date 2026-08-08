import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelUsage } from '@awb/domain';
import type { AgentEventSink } from './adapter.js';
import {
  boundedSummary,
  CliStreamAdapter,
  type CliArgvContext,
  type CliStreamAccumulator,
  type RunCliStreaming,
} from './cli-runtime.js';
import { renderOpenCodeAgentFile } from './opencode-tools.js';

/**
 * OpenCode discovers agents in `~/.config/opencode/agent/*.md` (XDG global) from ANY cwd — so
 * materializing the ephemeral role agent there (rather than a per-cwd `.opencode/agent/`) keeps it
 * out of the task worktree's tracked tree entirely. Overridable for tests.
 */
export function openCodeAgentDir(): string {
  return join(homedir(), '.config', 'opencode', 'agent');
}

/**
 * Materialize a capability-scoped OpenCode agent and return its name. The name is a hash of the
 * granted capabilities, so identical grants reuse one file (idempotent) and distinct roles get
 * distinct permission scopes. Injectable `writeAgent` lets tests capture the write without touching
 * the real config dir.
 */
export function materializeOpenCodeAgent(
  capabilities: readonly string[],
  writeAgent: (name: string, contents: string) => void = defaultWriteAgent,
): string {
  const hash = createHash('sha1').update([...capabilities].sort().join(',')).digest('hex').slice(0, 10);
  const name = `awb-${hash}`;
  writeAgent(name, renderOpenCodeAgentFile(name, capabilities));
  return name;
}

function defaultWriteAgent(name: string, contents: string): void {
  const dir = openCodeAgentDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), contents, 'utf8');
}

export interface OpenCodeAdapterOptions {
  runCliStreaming?: RunCliStreaming;
  /** Path/name of the `opencode` binary. Default `opencode` (resolved on PATH). */
  bin?: string;
  /** Model id in `provider/model` form (e.g. `anthropic/claude-sonnet-4-5`). Omit to use the default. */
  model?: string;
  stallTimeoutMs?: number;
  /** Injectable agent-file writer (tests capture the materialized agent instead of touching ~/.config). */
  writeAgent?: (name: string, contents: string) => void;
}

/**
 * `CodingAgentAdapter` backed by the `opencode` CLI in non-interactive JSON mode
 * (`opencode run --format json`). The capability boundary is enforced via an AGENT: OpenCode has no
 * per-run tool flag, so the adapter materializes a capability-scoped agent (a `permission:` block
 * denying every tool the role wasn't granted) into `~/.config/opencode/agent/` and selects it with
 * `--agent`. This replaces `--dangerously-skip-permissions`, which auto-approved EVERYTHING and let a
 * read-only role mutate the worktree. Resume continues a prior session via `--session <id>`. Stream
 * schema verified live (`step_start`/`text`/`tool_use`/`step_finish`).
 */
export class OpenCodeAgentAdapter extends CliStreamAdapter {
  readonly id = 'opencode';
  protected readonly defaultBin = 'opencode';
  private readonly writeAgent?: (name: string, contents: string) => void;

  constructor(opts: OpenCodeAdapterOptions = {}) {
    super(opts);
    this.writeAgent = opts.writeAgent;
  }

  protected buildArgv(ctx: CliArgvContext): string[] {
    // `--dir` pins OpenCode's project directory to the task worktree. OpenCode does NOT confine its
    // tools to the process cwd — it infers a project root and otherwise drifts to wherever the daemon
    // runs (the workbench repo), editing the wrong repository (TASK-31; observed live: builder read/
    // wrote agent-workbench instead of the target, so QA never converged). Verified: `run --dir` scopes
    // its bash/read/edit tools to that directory.
    const agent = materializeOpenCodeAgent(ctx.allowedTools, this.writeAgent);
    const args = ['run', '--format', 'json', '--dir', ctx.cwd, '--agent', agent];
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

/** OpenCode's `part.tokens` on a single `step_finish` event → a ModelUsage for that one step. */
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
      const step = openCodeUsage(part);
      if (step) {
        // OpenCode reports per-step tokens: `output` is that step alone (sum it), but `input`
        // re-counts the accumulated context each step (already cumulative), so keep the latest.
        const prev = acc.usage;
        acc.usage = {
          ...step,
          inputTokens: step.inputTokens,
          outputTokens: (prev?.outputTokens ?? 0) + step.outputTokens,
        };
      }
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
