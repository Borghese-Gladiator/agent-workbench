import { spawn } from 'node:child_process';

export interface RunCommandOptions {
  command: string;
  args?: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /**
   * Invoked synchronously with the child's pid as soon as it is spawned, so
   * callers (e.g. a process registry) can track/kill it before it completes.
   */
  onSpawn?: (pid: number) => void;
}

export interface CommandResult {
  command: string;
  cwd: string;
  pid: number | undefined;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Kills an entire process tree rooted at `pid`.
 *
 * Strategy: the child is spawned with `detached: true`, which on POSIX makes
 * it the leader of a new process group whose group id equals its pid. Sending
 * a signal to the *negative* pid (`process.kill(-pid, signal)`) delivers that
 * signal to every process in the group, i.e. the spawned process and every
 * descendant it forked (e.g. `pnpm test` -> node subprocesses), not just the
 * immediate child. This avoids leaving orphaned grandchildren behind, which a
 * naive single-PID kill would.
 *
 * On non-POSIX platforms (Windows has no process groups in this sense), we
 * fall back to killing just the top-level pid.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
    } catch {
      // process already gone
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // group may already be gone; fall back to the single pid
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const { command, args = [], cwd, env, timeoutMs, onSpawn } = options;
  const startedAt = new Date().toISOString();

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
    });

    if (child.pid !== undefined) {
      onSpawn?.(child.pid);
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        command: args.length > 0 ? `${command} ${args.join(' ')}` : command,
        cwd,
        pid: child.pid,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode,
        stdout,
        stderr,
        timedOut,
      });
    };

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          killProcessTree(child.pid, 'SIGKILL');
        }
      }, timeoutMs);
    }

    child.on('error', () => {
      finish(null);
    });

    child.on('close', (code) => {
      finish(code);
    });
  });
}
