import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compressCommandOutput, killProcessTree, runCommand } from './command-runner.js';

const baseEnv = { PATH: process.env.PATH ?? '' };

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('compressCommandOutput', () => {
  it('leaves small output untouched', () => {
    expect(compressCommandOutput('hello\nworld')).toBe('hello\nworld');
    expect(compressCommandOutput('')).toBe('');
  });

  it('bounds line count with a head/tail window and a truncation marker', () => {
    const input = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    const out = compressCommandOutput(input, { maxLines: 100, elideRepeatedLines: false });
    const lines = out.split('\n');
    expect(lines.length).toBeLessThanOrEqual(101);
    expect(out).toContain('line 0');
    expect(out).toContain('line 999');
    expect(out).toMatch(/line\(s\) truncated/);
  });

  it('bounds bytes on a single huge line', () => {
    const input = 'x'.repeat(2_000_000);
    const out = compressCommandOutput(input, { maxBytes: 1024 });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1024);
    expect(out).toContain('output truncated');
  });

  it('elides runs of identical lines', () => {
    const input = ['start', ...Array.from({ length: 50 }, () => 'DUP'), 'end'].join('\n');
    const out = compressCommandOutput(input);
    expect(out).toBe('start\nDUP\n… [49 identical line(s) elided]\nend');
  });
});

describe('runCommand', () => {
  it('applies the byte bound to captured stdout by default', async () => {
    const result = await runCommand({
      command: 'node',
      args: ['-e', "process.stdout.write('y'.repeat(2000000))"],
      cwd: process.cwd(),
      env: baseEnv,
      compression: { maxBytes: 4096 },
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(4096);
  });


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
