/**
 * ValidationRunner: runs a project's test/lint/typecheck/e2e command inside a
 * task worktree and reports whether it passed. The captured output feeds the
 * `validation_report` artifact so a human (and the proof-run bundle) can see the
 * real result rather than a hardcoded "passed".
 */

import { spawn } from 'node:child_process';

export type ValidationKind = 'test' | 'lint' | 'typecheck' | 'e2e';

export interface ValidationRequest {
  taskId: string;
  cwd: string;
  kind: ValidationKind;
  command: string;
}

export interface ValidationResult {
  kind: ValidationKind;
  status: 'passed' | 'failed' | 'skipped';
  /** Captured combined stdout+stderr, for the validation report. */
  output: string;
}

export interface ValidationRunner {
  run(req: ValidationRequest): Promise<ValidationResult>;
}

/** Human label for a validation kind, used in reports. */
export const KIND_LABEL: Record<ValidationKind, string> = {
  test: 'Tests',
  lint: 'Lint',
  typecheck: 'Typecheck',
  e2e: 'E2E',
};

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/**
 * Scope a pytest-shaped test command to the task's changed test files so
 * validation runs ONLY the tests the change touched — not the whole repo suite.
 *
 * The enterprise `app` project's `testCommand` is `bin/pytest -m unit`, which runs
 * every unit test in the monorepo. For a single-file change that is multi-minute
 * and (since validation is synchronous) freezes the daemon. Appending the changed
 * test paths turns it into `bin/pytest -m unit tests/.../test_foo.py` — seconds.
 *
 * Conservative by design: only rewrites pytest commands, and only when there is at
 * least one changed test path. Anything else (non-pytest runner, or a change that
 * touched no test file) returns the command unchanged so we never silently skip
 * coverage we can't scope.
 */
export function scopeTestCommand(command: string, changedTestPaths: string[]): string {
  const trimmed = command.trim();
  if (!trimmed) return command;
  if (!/\bpytest\b/.test(trimmed)) return command;
  const paths = changedTestPaths.filter((p) => p.trim());
  if (paths.length === 0) return command;
  // Quote each path defensively (spaces/special chars) and append.
  const quoted = paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ');
  return `${trimmed} ${quoted}`;
}

/**
 * Does a repo-relative path look like a test file? Covers pytest
 * (`test_*.py` / `*_test.py` / anything under a `tests/` dir) and JS test runners
 * (`*.test.*` / `*.spec.*`). Used to pick which changed files scope the test run.
 */
export function isTestPath(path: string): boolean {
  const p = path.trim();
  if (!p) return false;
  const base = p.split('/').pop() ?? p;
  return (
    /(^|\/)tests?\//.test(p) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.py$/.test(base) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)
  );
}

/**
 * Runs the command via the shell inside the worktree. Uses async `spawn` (NOT
 * `spawnSync`): a validation command can run for minutes (enterprise pytest /
 * turbo), and a sync spawn would block the daemon's event loop for that whole
 * window — starving keep-alive HTTP polls into transient ECONNRESETs (the demo
 * recorder's mid-`verification` death) and stalling sibling vitest tests on a
 * shared worker loop. Async `spawn` gives the caller the same "resolves when the
 * child exits" guarantee while keeping the loop live. The lifecycle driver is
 * already an awaited sequential state machine, so this does not change stage
 * ordering — only whether the loop is frozen during the wait.
 */
export class CommandValidationRunner implements ValidationRunner {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  run(req: ValidationRequest): Promise<ValidationResult> {
    const command = req.command.trim();
    if (!command) {
      return Promise.resolve({ kind: req.kind, status: 'skipped', output: '' });
    }

    return new Promise<ValidationResult>((resolve) => {
      const child = spawn(command, {
        cwd: req.cwd,
        shell: true,
        timeout: this.timeoutMs,
      });

      let output = '';
      let truncated = false;
      const MAX = 32 * 1024 * 1024; // match the old spawnSync maxBuffer cap
      const capture = (d: Buffer) => {
        if (truncated) return;
        output += d.toString();
        if (output.length > MAX) {
          output = output.slice(0, MAX);
          truncated = true;
          child.kill('SIGKILL'); // mirror spawnSync's maxBuffer-exceeded kill
        }
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);

      let spawnError: Error | null = null;
      child.on('error', (err) => {
        spawnError = err;
      });

      child.on('close', (code, signal) => {
        // A spawn failure, a non-zero/null exit, or a timeout kill (signal set,
        // no clean code) surfaces as failed — same contract as the old sync path.
        if (spawnError || (code === null && signal)) {
          const reason = spawnError
            ? `${spawnError.message}\n`
            : `process terminated by ${signal}\n`;
          resolve({ kind: req.kind, status: 'failed', output: reason + output });
          return;
        }
        resolve({
          kind: req.kind,
          status: code === 0 ? 'passed' : 'failed',
          output,
        });
      });
    });
  }
}

/** Not implemented — retained for tests/back-compat that want a throwing stub. */
export class UnimplementedValidationRunner implements ValidationRunner {
  async run(_req: ValidationRequest): Promise<ValidationResult> {
    throw new Error('ValidationRunner is not implemented in this increment.');
  }
}
