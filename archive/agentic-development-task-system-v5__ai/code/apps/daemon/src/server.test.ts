import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { discoverRepository } from '../../../workers/temporal-worker/dist/activities/discovery-support.js';
import { buildServer, type DaemonServer } from './server.js';
import { setTemporalClientForTesting } from './temporal-client.js';
import { taskQueueName } from './temporal-worker-constants.js';

const execFileAsync = promisify(execFile);

async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'awb-daemon-fixture-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'echo test' } }),
  );
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('daemon server', () => {
  let dataDir: string;
  let fixtureRepo: string;
  let server: DaemonServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'awb-daemon-data-'));
    process.env.AWB_DATA_DIR = dataDir;
    fixtureRepo = await makeFixtureRepo();
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.AWB_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
    await rm(fixtureRepo, { recursive: true, force: true });
  });

  it('responds ok on /api/health', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('registers a repository via POST /api/repositories', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/repositories',
      payload: { canonicalPath: fixtureRepo },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.trusted).toBe(false);
    expect(body.canonicalPath).toBe(fixtureRepo);
  });

  it('rejects registering a non-git directory with a 400', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/repositories',
      payload: { canonicalPath: dataDir },
    });
    expect(response.statusCode).toBe(400);
  });

  it('lists registered repositories via GET /api/repositories', async () => {
    await server.app.inject({ method: 'POST', url: '/api/repositories', payload: { canonicalPath: fixtureRepo } });
    const response = await server.app.inject({ method: 'GET', url: '/api/repositories' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
  });

  it('returns 404 for an unknown repository id', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/api/repositories/not-a-real-id' });
    expect(response.statusCode).toBe(404);
  });

  it('drives the full add -> refresh -> approve -> inspect flow over HTTP', async () => {
    // Refresh is now a Temporal workflow (RepositoryDiscoveryWorkflow), so this
    // flow runs against a TestWorkflowEnvironment with a worker registering the discovery workflow +
    // activity. The activity writes the snapshot daemon-side, so it needs the daemon's data dir.
    const testEnv = await TestWorkflowEnvironment.createLocal();
    setTemporalClientForTesting(testEnv.client);
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: taskQueueName(),
      workflowsPath: new URL('../../../packages/workflow/dist/workflows.js', import.meta.url).pathname,
      activities: { discoverRepository },
    });

    // The discovery activity calls back into the daemon over HTTP (single-writer), so the daemon
    // must actually be listening — inject() alone isn't reachable from the worker process.
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    process.env.AWB_DAEMON_URL = `http://127.0.0.1:${port}`;

    try {
      await worker.runUntil(async () => {
        const addResponse = await server.app.inject({
          method: 'POST',
          url: '/api/repositories',
          payload: { canonicalPath: fixtureRepo },
        });
        const { id } = addResponse.json();

        const refreshResponse = await server.app.inject({ method: 'POST', url: `/api/repositories/${id}/refresh` });
        expect(refreshResponse.statusCode).toBe(200);
        // The refresh route now returns the discovery workflow result, not the raw snapshot.
        expect(refreshResponse.json()).toMatchObject({ repositoryId: id });
        expect(typeof refreshResponse.json().snapshotId).toBe('string');

        const approveResponse = await server.app.inject({ method: 'POST', url: `/api/repositories/${id}/approve` });
        expect(approveResponse.statusCode).toBe(200);

        const inspectResponse = await server.app.inject({ method: 'GET', url: `/api/repositories/${id}` });
        const inspected = inspectResponse.json();
        expect(inspected.repository.trusted).toBe(true);
        expect(inspected.latestSnapshot.headSha).toHaveLength(40);
      });
    } finally {
      delete process.env.AWB_DAEMON_URL;
      setTemporalClientForTesting(undefined);
      await testEnv.teardown();
    }
  }, 60_000);

  it('returns an empty list on GET /api/tasks when no tasks were created this process', async () => {
    // POST /api/tasks requires a live Temporal server, which this suite does not run against, so
    // this only exercises the route's shape with the in-memory list in its initial state.
    const response = await server.app.inject({ method: 'GET', url: '/api/tasks' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});
