import { spawn } from 'node:child_process';

export interface OutputCompressionOptions {
  /** Hard cap on the returned string in bytes (UTF-8). Overflow is head/tail clipped. */
  maxBytes?: number;
  /** Cap on the number of retained lines. Overflow keeps a head + tail window. */
  maxLines?: number;
  /** Collapse runs of an identical line into one line + an elision marker. Defaults to true. */
  elideRepeatedLines?: boolean;
}

const DEFAULT_COMPRESSION: Required<OutputCompressionOptions> = {
  maxBytes: 256 * 1024,
  maxLines: 2000,
  elideRepeatedLines: true,
};

/**
 * Clips accumulated stdout/stderr so a chatty child cannot flood the caller's context. Applies, in
 * order: repeated-line elision (a run of N identical lines becomes one line plus a marker), a
 * head/tail line-count cap (keep the first and last halves, drop the middle), and finally a hard
 * byte cap (keep a head and tail slice around a truncation marker). The result is always within
 * `maxBytes` and `maxLines`.
 */
export function compressCommandOutput(text: string, options?: OutputCompressionOptions): string {
  const { maxBytes, maxLines, elideRepeatedLines } = { ...DEFAULT_COMPRESSION, ...options };
  if (text.length === 0) return text;

  let lines = text.split('\n');

  if (elideRepeatedLines) {
    const collapsed: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] as string;
      let run = 1;
      while (i + run < lines.length && lines[i + run] === line) run += 1;
      collapsed.push(line);
      if (run > 1) collapsed.push(`… [${run - 1} identical line(s) elided]`);
      i += run;
    }
    lines = collapsed;
  }

  if (lines.length > maxLines) {
    const head = Math.ceil(maxLines / 2);
    const tail = maxLines - head;
    const dropped = lines.length - head - tail;
    lines = [...lines.slice(0, head), `… [${dropped} line(s) truncated]`, ...lines.slice(lines.length - tail)];
  }

  let out = lines.join('\n');

  const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');
  if (byteLength(out) > maxBytes) {
    const marker = '\n… [output truncated to byte cap] …\n';
    const budget = Math.max(0, maxBytes - byteLength(marker));
    const headBytes = Math.ceil(budget / 2);
    const buf = Buffer.from(out, 'utf8');
    const headStr = buf.subarray(0, headBytes).toString('utf8');
    const tailStr = buf.subarray(buf.length - (budget - Buffer.byteLength(headStr, 'utf8'))).toString('utf8');
    out = `${headStr}${marker}${tailStr}`;
    // The head/tail slice can split a multibyte char (replaced by U+FFFD), nudging length slightly
    // over budget; a final hard slice guarantees the byte bound.
    if (byteLength(out) > maxBytes) {
      out = Buffer.from(out, 'utf8').subarray(0, maxBytes).toString('utf8');
    }
  }

  return out;
}

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
  /**
   * Bounds applied to the captured stdout/stderr before the result is returned, so a chatty child
   * cannot flood the caller's context. Defaults applied when omitted; pass `false` to disable.
   */
  compression?: OutputCompressionOptions | false;
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
  const { command, args = [], cwd, env, timeoutMs, onSpawn, compression } = options;
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
      const clip = (text: string): string =>
        compression === false ? text : compressCommandOutput(text, compression);
      resolve({
        command: args.length > 0 ? `${command} ${args.join(' ')}` : command,
        cwd,
        pid: child.pid,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode,
        stdout: clip(stdout),
        stderr: clip(stderr),
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
