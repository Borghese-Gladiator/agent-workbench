import type { ModelUsage } from '@awb/domain';
import type { AgentEventSink } from './adapter.js';
import {
  boundedSummary,
  CliStreamAdapter,
  type CliArgvContext,
  type CliStreamAccumulator,
  type RunCliStreaming,
} from './cli-runtime.js';
import type { TaskPhase } from '@awb/domain';
import { capabilitiesToPiTools } from './pi-tools.js';

/**
 * The capable Ollama code model the Pi runtime defaults to — used for the reasoning + build phases
 * (plan/implement). Validated by a full live delivery run (2026-06-30).
 */
export const PI_DEFAULT_MODEL = 'ollama/qwen3-coder:30b';

/**
 * Per-phase Pi model routing. `qwen3-coder:30b` reliably STALLED on the heavy, long-context, low-tool
 * REVIEW phase (`challenge`) running locally — a fast small model (`llama3.2`) completes it. Every
 * other phase keeps the capable default. A project-configured model overrides this table for all
 * phases (see the pi profile's `modelForPhase`).
 */
const PI_PHASE_MODEL: Partial<Record<TaskPhase, string>> = {
  challenge: 'ollama/llama3.2:latest',
};

/** The Pi model for a phase: the per-phase override, else the capable {@link PI_DEFAULT_MODEL}. */
export function piModelForPhase(phase: TaskPhase): string {
  return PI_PHASE_MODEL[phase] ?? PI_DEFAULT_MODEL;
}

export interface PiAdapterOptions {
  runCliStreaming?: RunCliStreaming;
  /** Path/name of the `pi` binary. Default `pi` (resolved on PATH). */
  bin?: string;
  /** Model id/pattern (e.g. `ollama/qwen3-coder:30b`). Omit to use Pi's default. */
  model?: string;
  stallTimeoutMs?: number;
}

/**
 * `CodingAgentAdapter` backed by the locally-installed `pi` CLI in JSON event mode
 * (`pi --mode json -p …`). `pi` has no turn-cap flag (`--max-turns` is rejected), so the run is
 * bounded by the shared stall watchdog. `--no-context-files` keeps AGENTS.md/CLAUDE.md discovery
 * off — the caller inlines exactly the context it wants. Usage is aggregated from per-turn `usage`
 * objects (Pi reports no single cost line). Stream schema verified against pi 0.80.x.
 */
export class PiAgentAdapter extends CliStreamAdapter {
  readonly id = 'pi';
  protected readonly defaultBin = 'pi';

  constructor(opts: PiAdapterOptions = {}) {
    super(opts);
  }

  protected buildArgv(ctx: CliArgvContext): string[] {
    const args = ['--mode', 'json', '-p', ctx.prompt, '--no-context-files'];
    if (ctx.resumeSessionId) args.push('--session', ctx.resumeSessionId);
    if (this.model) args.push('--model', this.model);
    // Enforce the role's capability boundary structurally: `--tools` is the closed allowlist and
    // `--exclude-tools` the explicit complement, so a read-only role provably cannot edit/write/bash
    // (pi --mode json has no permission prompt to fall back on). An empty grant → a no-tool run.
    const policy = capabilitiesToPiTools(ctx.allowedTools);
    if (policy.tools.length) args.push('--tools', policy.tools.join(','));
    if (policy.excludeTools.length) args.push('--exclude-tools', policy.excludeTools.join(','));
    return args;
  }

  protected consumeLine(line: string, acc: CliStreamAccumulator, eventSink: AgentEventSink): void {
    consumePiStreamLine(line, acc, eventSink);
  }
}

/** Aggregate Pi's per-turn `usage` (camelCase, verified against pi 0.80.2) into a running total. */
function accumulatePiUsage(acc: CliStreamAccumulator, message: unknown): void {
  const usage = (message as { usage?: Record<string, number> } | undefined)?.usage;
  if (!usage) return;
  const pick = (camel: string, snake: string) => usage[camel] ?? usage[snake] ?? 0;
  const input = pick('input', 'input_tokens');
  const output = pick('output', 'output_tokens');
  const cached = pick('cacheRead', 'cache_read_input_tokens');
  const prev: ModelUsage = acc.usage ?? { provider: 'pi', model: 'pi', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  acc.usage = {
    provider: prev.provider,
    model: prev.model,
    inputTokens: prev.inputTokens + input,
    outputTokens: prev.outputTokens + output,
    cachedInputTokens: (prev.cachedInputTokens ?? 0) + cached,
  };
}

/**
 * Parse one NDJSON line from `pi --mode json`, emitting neutral `AgentEvent`s and accumulating
 * terminal state. Schema: top-level `type` ∈ {session, agent_start, turn_start, message_update,
 * message_end, tool_execution_start, tool_execution_end, turn_end, agent_end, auto_retry_end, ...}.
 */
export function consumePiStreamLine(line: string, acc: CliStreamAccumulator, eventSink: AgentEventSink): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  switch (msg.type) {
    case 'session': {
      if (typeof msg.id === 'string' && !acc.sessionId) acc.sessionId = msg.id;
      return;
    }
    case 'message_update': {
      const ev = msg.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
        acc.finalText += ev.delta;
        eventSink({ type: 'message', text: ev.delta });
      }
      return;
    }
    case 'tool_execution_start': {
      eventSink({ type: 'tool-started', tool: String(msg.toolName ?? 'tool'), inputSummary: boundedSummary(msg.args) });
      return;
    }
    case 'tool_execution_end': {
      eventSink({ type: 'tool-completed', tool: String(msg.toolName ?? 'tool'), resultSummary: boundedSummary(msg.result) });
      return;
    }
    case 'turn_end': {
      accumulatePiUsage(acc, msg.message);
      return;
    }
    case 'auto_retry_end': {
      if (msg.success === false && typeof msg.finalError === 'string') acc.errorMessage = msg.finalError;
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
