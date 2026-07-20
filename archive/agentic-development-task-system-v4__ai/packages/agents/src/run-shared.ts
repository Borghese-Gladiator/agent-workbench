/**
 * Runtime-neutral subprocess plumbing shared by the real agent adapters
 * (Claude, Pi, …). These pieces shell out to a CLI in a worktree and stream its
 * output; they know nothing about a specific runtime's flags or event shapes.
 *
 * Extracted from the Claude adapter so a second runtime reuses the SAME process
 * isolation (own process group), stall/abort wiring, and pgid capture rather
 * than reimplementing it (and diverging on the safety-critical kill path).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** What a one-shot invocation of an agent CLI returns. */
export interface CliResult {
  /** Process exit code (null if killed by signal). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Args passed to the (injectable) CLI runner. */
export interface CliInvocation {
  /** The binary to run (e.g. `claude`, `pi`). */
  bin: string;
  /** Full argv (excluding the binary). */
  args: string[];
  /** Working directory the process runs in — the worktree confinement. */
  cwd: string;
  /** Extra env vars for the spawned process (e.g. the MCP gate relay config). */
  env?: Record<string, string>;
  /** Abort to kill the spawned process (the adapter's stall watchdog). */
  signal?: AbortSignal;
}

/** The one-shot CLI runner seam — overridable in tests so we never shell out. */
export type RunCli = (invocation: CliInvocation) => Promise<CliResult>;

/** What a streaming invocation returns once the process closes. */
export interface CliStreamResult {
  code: number | null;
  stderr: string;
}

/**
 * The streaming CLI runner seam. Yields the child's stdout one line at a time
 * (NDJSON) and resolves to the exit code + captured stderr when the process
 * closes. Overridable in tests to feed scripted lines without spawning.
 */
export type RunCliStreaming = (
  invocation: CliInvocation,
  onLine: (line: string) => void | Promise<void>,
  /** Called once with the spawned child's process-group id (best-effort). */
  onSpawn?: (pgid: number) => void,
) => Promise<CliStreamResult>;

/**
 * Marker env on every workbench-spawned agent process. The agents run
 * non-interactively (no human watching each shell call), so user-level
 * interactive-session hooks provide no safety value here and only burn turns on
 * trial-and-error; such hooks check for this var and no-op when the caller is
 * the workbench. The real safety boundary for these runs is the constrained
 * tool set + worktree isolation, not the hook.
 */
export const WORKBENCH_AGENT_ENV = { WORKBENCH_AGENT: '1' } as const;

/** Default one-shot runner: spawn the binary, capture stdout/stderr, confined to cwd. */
export const defaultRunCli: RunCli = ({ bin, args, cwd }) =>
  new Promise<CliResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...WORKBENCH_AGENT_ENV },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

/**
 * Default streaming runner: spawn the binary and emit stdout line-by-line via a
 * readline interface, capturing stderr, resolving on close. Confined to cwd.
 *
 * The child leads its own process group (POSIX setsid via `detached`): the agent
 * process AND any child it spawns (e.g. an MCP server) share this group, so one
 * group-kill reaps the whole tree, and a later daemon boot can reap it by the
 * recorded pgid. We do NOT unref — the daemon owns the child's stream/lifecycle
 * during normal runs.
 */
export const defaultRunCliStreaming: RunCliStreaming = (
  { bin, args, cwd, env, signal },
  onLine,
  onSpawn,
) =>
  new Promise<CliStreamResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...WORKBENCH_AGENT_ENV, ...(env ?? {}) },
      detached: true,
    });
    // A detached child leads its own group; the group id equals the leader pid.
    if (child.pid != null) onSpawn?.(child.pid);
    // Stall watchdog / stop hook: an abort group-kills the child (negative pid =
    // the whole process group), so any child dies with it; the normal `close`
    // path then resolves with the kill signal's exit code. Fall back to a direct
    // kill if the group signal fails (e.g. child already reaped).
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
    rl.on('line', (line) => {
      void onLine(line);
    });
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

/** Pull the LAST fenced ```json block from text and parse it; null if none/invalid. */
export function extractJsonBlock(text: string): unknown | null {
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)```/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]?.[1] ?? '';
  try {
    return JSON.parse(last.trim());
  } catch {
    return null;
  }
}
