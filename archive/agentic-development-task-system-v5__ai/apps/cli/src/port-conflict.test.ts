import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectServicePort, pidHoldingPort } from './process-control.js';
import { pidPathFor } from './services.js';

/** Binds an ephemeral port and returns it, so the test asserts against a REAL listener. */
async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('expected a TCP address');
  return { server, port: address.port };
}

// TASK-111: a stale `tsx watch` daemon from a DIFFERENT worktree held 4417, and the main daemon
// crash-looped against it ~70 times. Nothing detected or refused the second binding, so the only
// symptom was a stack that never became healthy and a log nobody had reason to read.
describe('port conflict detection (TASK-111)', () => {
  let dataDir: string;
  let server: Server | undefined;
  let port = 0;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'awb-port-'));
    process.env.AWB_DATA_DIR = dataDir;
    ({ server, port } = await listen());
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    delete process.env.AWB_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('finds the pid actually holding a bound port', () => {
    // `lsof` may be absent; when it is, the lookup reports undefined and callers treat the port as
    // free, so a missing tool can never block a boot. Only assert the pid when we got an answer.
    const holder = pidHoldingPort(port);
    if (holder) expect(holder.pid).toBe(process.pid);
  });

  it('reports a port nothing listens on as free', () => {
    // Port 1 is privileged and unbound in any sane test environment.
    expect(inspectServicePort('daemon', 1)).toEqual({ state: 'free' });
  });

  it('calls the holder OURS when it is the pid this checkout recorded', () => {
    if (!pidHoldingPort(port)) return; // lsof unavailable
    writeFileSync(pidPathFor('daemon'), String(process.pid));
    expect(inspectServicePort('daemon', port)).toEqual({ state: 'ours', pid: process.pid });
  });

  // The case worth refusing: the port is taken by a process this checkout did not start, so
  // starting the service can only reproduce the crash-loop.
  it('calls the holder FOREIGN when no pid file matches it', () => {
    if (!pidHoldingPort(port)) return; // lsof unavailable
    writeFileSync(pidPathFor('daemon'), '999999');
    expect(inspectServicePort('daemon', port)).toMatchObject({ state: 'foreign', pid: process.pid });
  });
});
