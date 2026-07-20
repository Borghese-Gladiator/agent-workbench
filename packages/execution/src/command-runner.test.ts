import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killProcessTree, runCommand } from './command-runner.js';

const baseEnv = { PATH: process.env.PATH ?? '' };

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runCommand', () => {
  it('captures stdout and exit code for a successful command', async () => {
    const result = await runCommand({
      command: 'node',
      args: ['-e', "console.log('hi')"],
      cwd: process.cwd(),
      env: baseEnv,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hi');
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr and a non-zero exit code', async () => {
    const result = await runCommand({
      command: 'sh',
      args: ['-c', 'echo boom 1>&2; exit 3'],
      cwd: process.cwd(),
      env: baseEnv,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
    expect(result.timedOut).toBe(false);
  });

  it('kills a command that exceeds the timeout and reports timedOut', async () => {
    const result = await runCommand({
      command: 'sh',
      args: ['-c', 'sleep 5'],
      cwd: process.cwd(),
      env: baseEnv,
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 2000);

  it('kills the entire process tree, not just the top-level process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awb-execution-'));
    const heartbeatFile = join(dir, 'heartbeat');
    const childPidFile = join(dir, 'child.pid');

    try {
      // The top-level shell backgrounds a heartbeat-writing loop (the
      // "grandchild") and then itself sleeps, staying alive so we can kill
      // the whole tree mid-flight. A naive kill of only the shell's pid
      // would leave the backgrounded loop running as an orphan.
      const script = [
        `(while true; do date +%s%N > "${heartbeatFile}"; sleep 0.05; done) &`,
        `echo $! > "${childPidFile}"`,
        `sleep 5`,
      ].join('\n');

      let capturedPid: number | undefined;
      const runPromise = runCommand({
        command: 'sh',
        args: ['-c', script],
        cwd: process.cwd(),
        env: baseEnv,
        onSpawn: (pid) => {
          capturedPid = pid;
        },
      });

      // Wait for the grandchild to start writing heartbeats.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const childPid = Number(readFileSync(childPidFile, 'utf8').trim());
      expect(isProcessAlive(childPid)).toBe(true);

      const heartbeatBefore = readFileSync(heartbeatFile, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(readFileSync(heartbeatFile, 'utf8')).not.toBe(heartbeatBefore);

      expect(capturedPid).toBeDefined();
      killProcessTree(capturedPid as number, 'SIGKILL');

      await runPromise;

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(isProcessAlive(childPid)).toBe(false);

      const heartbeatAtKill = readFileSync(heartbeatFile, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(readFileSync(heartbeatFile, 'utf8')).toBe(heartbeatAtKill);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 3000);
});
