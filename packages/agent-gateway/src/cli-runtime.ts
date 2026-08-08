import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ModelUsage } from '@awb/domain';
import type {
  AgentAssignment,
  AgentEventSink,
  AgentExecutionResult,
  AgentSession,
  CodingAgentAdapter,
  CreateAgentSessionInput,
} from './adapter.js';

/**
 * Runtime-neutral subprocess plumbing + a base `CodingAgentAdapter` for every runtime that shells
 * out to a coding-agent CLI (Codex, Pi, OpenCode). It knows nothing about a specific CLI's flags or
 * stream shapes — a subclass supplies the argv and the per-line NDJSON parser. The base owns the
 * safety-critical pieces every CLI adapter shares: worktree confinement, an own-process-group spawn
 * so one group-kill reaps the whole tree, the stall/abort watchdog, session/resume-token capture,
 * and the mapping from a parsed stream into the neutral `AgentEvent`/`AgentExecutionResult` shapes.
 */

/** Args passed to the (injectable) streaming CLI runner. */
export interface CliInvocation {
  /** The binary to run (e.g. `codex`, `pi`, `opencode`). */
  bin: string;
  /** Full argv (excluding the binary). */
  args: string[];
  /** Working directory the process runs in — the worktree confinement. */
  cwd: string;
  /** Extra env vars for the spawned process. */
  env?: Record<string, string>;
  /** Abort to kill the spawned process (the adapter's stall watchdog / external stop). */
  signal?: AbortSignal;
}

/** What a streaming invocation returns once the process closes. */
export interface CliStreamResult {
  code: number | null;
  stderr: string;
}

/**
 * The streaming CLI runner seam. Yields the child's stdout one line at a time (NDJSON) and resolves
 * to the exit code + captured stderr when the process closes. Overridable in tests to feed scripted
 * lines without spawning a real subprocess.
 */
export type RunCliStreaming = (
  invocation: CliInvocation,
  onLine: (line: string) => void,
) => Promise<CliStreamResult>;

/**
 * Marker env on every workbench-spawned agent process. The agents run non-interactively, so
 * user-level interactive-session hooks provide no safety value here; such hooks check for this var
 * and no-op. The real safety boundary is the constrained tool set + worktree isolation.
 */
export const WORKBENCH_AGENT_ENV = { WORKBENCH_AGENT: '1' } as const;

/**
 * Default streaming runner: spawn the binary and emit stdout line-by-line via a readline interface,
 * capturing stderr, resolving on close. Confined to `cwd`. The child leads its own process group
 * (POSIX setsid via `detached`) so one group-kill reaps the agent AND any child it spawns.
 */
export const defaultRunCliStreaming: RunCliStreaming = ({ bin, args, cwd, env, signal }, onLine) =>
  new Promise<CliStreamResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...WORKBENCH_AGENT_ENV, ...(env ?? {}) },
      detached: true,
    });
    const onAbort = () => {
      try {
        if (child.pid != null) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => onLine(line));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      rl.close();
      resolve({ code, stderr });
    });
  });

/** Default 10-minute stall watchdog, matching the archived adapters. */
export const DEFAULT_STALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Terminal state a subclass parser accumulates across one streaming run. */
export interface CliStreamAccumulator {
  /** The agent's final assistant text, concatenated across turns. */
  finalText: string;
  /** The provider's session/thread id, for `--session`/`resume` continuation. */
  sessionId?: string;
  /** Set on a fatal stream-level error (distinct from a non-zero exit). */
  errorMessage?: string;
  /** Aggregated model usage, if the CLI reports it. */
  usage?: ModelUsage;
}

/** A fresh accumulator (run start). */
export function newCliAccumulator(): CliStreamAccumulator {
  return { finalText: '' };
}

/** The context a subclass needs to build its argv for one execute() call. */
export interface CliArgvContext {
  /** The full prompt for a cold turn (context preamble + instruction) or the bare instruction on resume. */
  prompt: string;
  /**
   * The absolute worktree directory the session runs in. The base already spawns the CLI with this as
   * its process `cwd`, but a runtime whose TOOLS don't inherit the process cwd (OpenCode infers its
   * own project root and drifts to wherever the daemon runs — TASK-31) must pass it explicitly, e.g.
   * `opencode run --dir <cwd>`.
   */
  cwd: string;
  /** The prior session id when resuming, else undefined (cold start). */
  resumeSessionId?: string;
  /** Turn budget, if the caller set one. */
  maxTurns?: number;
  /**
   * The session's granted capabilities (the abstract `@awb/capability-broker` strings, e.g.
   * `repository.read`, `worktree.write`), for the subclass to map onto its own tool-restriction
   * surface (Pi `--tools`/`--exclude-tools`). The base doesn't interpret them — a runtime with no
   * tool-restriction surface simply ignores this.
   */
  allowedTools: readonly string[];
  /** The complement the caller wants denied, if it computed one (unused by runtimes that derive deny from allow). */
  disallowedTools: readonly string[];
}

interface CliSessionState {
  cwd: string;
  contextPayload: unknown;
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  resumeSessionId?: string;
  abort?: AbortController;
}

/**
 * Serializes the session's contextPayload into a prompt preamble, mirroring the Claude adapter: the
 * CLI only receives the instruction as the prompt, so a role whose instruction doesn't embed its
 * inputs (plan-critic, reviewer) never sees the plan/diff/contract without this. Only prepended on a
 * COLD turn (a resumed turn already carries the context in its transcript). Large payloads truncated.
 */
export function contextPreamble(contextPayload: unknown): string {
  if (contextPayload === undefined || contextPayload === null) return '';
  let serialized: string;
  try {
    serialized = JSON.stringify(contextPayload, null, 2);
  } catch {
    return '';
  }
  if (!serialized || serialized === '{}' || serialized === 'null') return '';
  const MAX = 60_000;
  const body =
    serialized.length > MAX ? `${serialized.slice(0, MAX)}\n…[truncated ${serialized.length - MAX} chars]` : serialized;
  return `Context for this task (JSON):\n\`\`\`json\n${body}\n\`\`\`\n\n`;
}

/** Bound a tool-result / arbitrary content to a short string summary for an event payload. */
export function boundedSummary(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * Base `CodingAgentAdapter` for CLI-backed runtimes. Subclasses implement {@link buildArgv} (the
 * runtime's flags) and {@link consumeLine} (its NDJSON schema → events + accumulator). Everything
 * else — session lifecycle, worktree confinement, spawn/kill, stall watchdog, resume-token
 * threading, and the failure taxonomy — lives here once.
 */
export abstract class CliStreamAdapter implements CodingAgentAdapter {
  abstract readonly id: string;
  /** The default binary name; overridable per-instance via constructor opts. */
  protected abstract readonly defaultBin: string;

  protected readonly bin: string;
  protected readonly model?: string;
  protected readonly stallTimeoutMs: number;
  private readonly runCliStreaming: RunCliStreaming;
  private readonly state = new Map<string, CliSessionState>();

  constructor(opts: { runCliStreaming?: RunCliStreaming; bin?: string; model?: string; stallTimeoutMs?: number } = {}) {
    this.runCliStreaming = opts.runCliStreaming ?? defaultRunCliStreaming;
    // `defaultBin` is set by the subclass field initializer, which runs AFTER super(); fall back to
    // opts.bin here and resolve the subclass default lazily in `resolveBin()`.
    this.bin = opts.bin ?? '';
    this.model = opts.model;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  }

  private resolveBin(): string {
    return this.bin || this.defaultBin;
  }

  /** Build the argv (excluding the binary) for one execute() call. */
  protected abstract buildArgv(ctx: CliArgvContext): string[];

  /** Parse one NDJSON line, emitting events + mutating the accumulator's terminal state. */
  protected abstract consumeLine(line: string, acc: CliStreamAccumulator, eventSink: AgentEventSink): void;

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    if (!input.cwd || !isAbsolute(input.cwd)) {
      throw new Error(`${this.id}.createSession: cwd must be an absolute path, got ${JSON.stringify(input.cwd)}`);
    }
    const session: AgentSession = {
      id: randomUUID(),
      role: input.role,
      taskId: input.taskId,
      providerId: this.id,
      createdAt: new Date().toISOString(),
    };
    this.state.set(session.id, {
      cwd: input.cwd,
      contextPayload: input.contextPayload,
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools ?? [],
      resumeSessionId: input.resumeSessionId,
    });
    return session;
  }

  async execute(
    session: AgentSession,
    assignment: AgentAssignment,
    eventSink: AgentEventSink,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const state = this.state.get(session.id);
    if (!state) throw new Error(`${this.id}: unknown session ${session.id}`);
    if (signal.aborted) return { completed: false, findings: [], summary: 'aborted before start' };

    const prompt =
      state.resumeSessionId === undefined
        ? `${contextPreamble(state.contextPayload)}${assignment.instruction}`
        : assignment.instruction;

    const args = this.buildArgv({
      prompt,
      cwd: state.cwd,
      resumeSessionId: state.resumeSessionId,
      maxTurns: assignment.stopConditions?.maxTurns,
      allowedTools: state.allowedTools,
      disallowedTools: state.disallowedTools,
    });

    const acc = newCliAccumulator();
    acc.sessionId = state.resumeSessionId;

    // Stall watchdog + external stop: an abort group-kills the child. `stopped` distinguishes an
    // operator/caller abort from the watchdog firing, so the failure summary is accurate.
    const watchdog = new AbortController();
    state.abort = watchdog;
    let lastActivity = Date.now();
    let stalled = false;
    let stopped = false;
    const onAbort = () => {
      stopped = true;
      watchdog.abort();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

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

    let stream: CliStreamResult;
    try {
      stream = await this.runCliStreaming(
        { bin: this.resolveBin(), args, cwd: state.cwd, signal: watchdog.signal },
        (line) => {
          lastActivity = Date.now();
          this.consumeLine(line, acc, eventSink);
          if (acc.sessionId) state.resumeSessionId = acc.sessionId;
        },
      );
    } catch (err) {
      signal.removeEventListener('abort', onAbort);
      if (checker) clearInterval(checker);
      state.abort = undefined;
      const message = stopped ? 'stopped by operator' : err instanceof Error ? err.message : String(err);
      return { completed: false, findings: [], usage: acc.usage, summary: `${this.id} run failed: ${message}`, sessionId: acc.sessionId };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (checker) clearInterval(checker);
      state.abort = undefined;
    }

    if (acc.usage) eventSink({ type: 'usage', usage: acc.usage });

    if (stopped || stalled) {
      const message = stopped ? 'stopped by operator' : `stalled: no stream activity for ${this.stallTimeoutMs}ms — killed`;
      return { completed: false, findings: [], usage: acc.usage, summary: `${this.id} run interrupted: ${message}`, sessionId: acc.sessionId };
    }

    // A non-zero exit, a stream-level error, or no output at all = failure.
    const failed = stream.code !== 0 || Boolean(acc.errorMessage) || acc.finalText.trim() === '';
    if (failed) {
      const reason = acc.errorMessage
        ? `error: ${acc.errorMessage}`
        : acc.finalText.trim() === ''
          ? 'empty output'
          : `exit ${stream.code}`;
      return { completed: false, findings: [], usage: acc.usage, summary: `${this.id} run did not succeed (${reason})`, sessionId: acc.sessionId };
    }

    return { completed: true, findings: [], usage: acc.usage, summary: acc.finalText || 'execution completed', sessionId: acc.sessionId };
  }

  async interrupt(session: AgentSession): Promise<void> {
    this.state.get(session.id)?.abort?.abort();
  }

  async dispose(session: AgentSession): Promise<void> {
    this.state.get(session.id)?.abort?.abort();
    this.state.delete(session.id);
  }
}
