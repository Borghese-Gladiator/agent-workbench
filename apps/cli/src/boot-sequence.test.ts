import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForRuntimeReady } from './health.js';
import { clearStalePid, waitForPort } from './process-control.js';
import { pidPathFor } from './services.js';

/** A stand-in daemon whose /api/status answer the test controls. */
async function startStatusServer(next: () => Record<string, string>): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ runtime: 'x', services: next() }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const READY = { temporal: 'ready', worker: 'ready', daemon: 'ready' };
const WORKER_BUILDING = { temporal: 'ready', worker: 'unhealthy', daemon: 'ready' };

describe('waitForRuntimeReady (TASK-127)', () => {
  let server: Server | undefined;
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.AWB_DAEMON_URL;
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
    if (savedUrl === undefined) delete process.env.AWB_DAEMON_URL;
    else process.env.AWB_DAEMON_URL = savedUrl;
  });

  it('keeps waiting while the worker is still building its bundle, then returns ready', async () => {
    // The exact race that made `up` fail: the daemon answers, the worker does not yet.
    let polls = 0;
    const started = await startStatusServer(() => (++polls >= 3 ? READY : WORKER_BUILDING));
    server = started.server;
    process.env.AWB_DAEMON_URL = `http://127.0.0.1:${started.port}`;

    const readiness = await waitForRuntimeReady(10_000, 10);

    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it('reports which service blocked when the budget runs out', async () => {
    const started = await startStatusServer(() => WORKER_BUILDING);
    server = started.server;
    process.env.AWB_DAEMON_URL = `http://127.0.0.1:${started.port}`;

    const readiness = await waitForRuntimeReady(60, 10);

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((b) => b.key)).toEqual(['worker']);
  });
});

describe('waitForPort (TASK-127)', () => {
  it('returns true once the port accepts a connection', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await waitForPort(port, 2_000)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('returns false when nothing ever listens', async () => {
    // Port 1 is privileged and never bound by this process, so the probe can only fail.
    expect(await waitForPort(1, 300)).toBe(false);
  });
});

describe('clearStalePid (TASK-127)', () => {
  let dataDir: string;
  let savedDataDir: string | undefined;

  beforeEach(async () => {
    savedDataDir = process.env.AWB_DATA_DIR;
    dataDir = await mkdtemp(join(tmpdir(), 'awb-pid-'));
    process.env.AWB_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (savedDataDir === undefined) delete process.env.AWB_DATA_DIR;
    else process.env.AWB_DATA_DIR = savedDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('removes the pid file a crashed service left behind', async () => {
    const path = pidPathFor('worker');
    // pid 1 is init and always alive, so a dead pid must be one that cannot exist: use a
    // deliberately out-of-range value.
    await writeFile(path, '2147483646', 'utf8');

    expect(clearStalePid('worker')).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('leaves a live pid alone', async () => {
    const path = pidPathFor('worker');
    await writeFile(path, String(process.pid), 'utf8');

    expect(clearStalePid('worker')).toBe(false);
    expect(existsSync(path)).toBe(true);
  });
});
