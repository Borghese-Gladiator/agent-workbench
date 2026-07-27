import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { buildServer, type DaemonServer } from '../server.js';
import { setTemporalClientForTesting } from '../temporal-client.js';
import { TASK_QUEUE } from '../temporal-worker-constants.js';
import { describeRuntimeStatus } from './status.js';

/**
 * A minimal Client stand-in whose describeTaskQueue rejects, simulating Temporal being unreachable
 * without depending on whether a real dev-server happens to be running on localhost.
 */
function unreachableTemporalClient(): Client {
  return {
    options: { namespace: 'default' },
    connection: {
      workflowService: {
        describeTaskQueue: () => Promise.reject(new Error('connect ECONNREFUSED')),
      },
    },
  } as unknown as Client;
}

describe('daemon /api/status', () => {
  let server: DaemonServer | undefined;
  let testEnv: TestWorkflowEnvironment | undefined;

  afterEach(async () => {
    setTemporalClientForTesting(undefined);
    if (server) {
      await server.close();
      server = undefined;
    }
    if (testEnv) {
      await testEnv.teardown();
      testEnv = undefined;
    }
    delete process.env.AWB_DATA_DIR;
  });

  it('reports temporal+worker unhealthy when Temporal is unreachable', async () => {
    setTemporalClientForTesting(unreachableTemporalClient());
    const status = await describeRuntimeStatus();
    expect(status.services.daemon).toBe('ready');
    expect(status.services.temporal).toBe('unhealthy');
    expect(status.services.worker).toBe('unhealthy');
    expect(status.runtime).toBe('unhealthy');
    expect(status.ok).toBe(false);
  }, 15_000);

  it('reports temporal ready but worker unhealthy with no poller', async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
    setTemporalClientForTesting(testEnv.client);

    const status = await describeRuntimeStatus();
    expect(status.services.temporal).toBe('ready');
    expect(status.services.worker).toBe('unhealthy');
    expect(status.runtime).toBe('unhealthy');
  }, 30_000);

  it('reports the whole runtime ready when a worker is polling the task queue', async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
    setTemporalClientForTesting(testEnv.client);
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: new URL('../../../../packages/workflow/dist/workflows.js', import.meta.url).pathname,
      activities: {},
    });

    await worker.runUntil(async () => {
      // Poll until the worker registers as a poller on the task queue.
      let status = await describeRuntimeStatus();
      const deadline = Date.now() + 10_000;
      while (status.services.worker !== 'ready' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        status = await describeRuntimeStatus();
      }
      expect(status.services.temporal).toBe('ready');
      expect(status.services.worker).toBe('ready');
      expect(status.runtime).toBe('ready');
      expect(status.ok).toBe(true);
    });
  }, 45_000);

  it('serves the status over HTTP with a 503 when unhealthy', async () => {
    setTemporalClientForTesting(unreachableTemporalClient());
    server = await buildServer();
    const response = await server.app.inject({ method: 'GET', url: '/api/status' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.services.daemon).toBe('ready');
    expect(body.runtime).toBe('unhealthy');
  }, 15_000);
});
