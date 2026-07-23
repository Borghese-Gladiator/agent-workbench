import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RepositoryDiscoveryWorkflow } from './discovery-workflow.js';

let testEnv: TestWorkflowEnvironment;
let queueCounter = 0;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await testEnv?.teardown();
});

describe('RepositoryDiscoveryWorkflow', () => {
  it('runs the discoverRepository activity and returns its snapshot id', async () => {
    const calls: Array<{ repositoryId: string }> = [];
    const taskQueue = `awb-discovery-queue-${++queueCounter}`;
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../dist/workflows.js', import.meta.url).pathname,
      activities: {
        async discoverRepository(input: { repositoryId: string }) {
          calls.push(input);
          return { snapshotId: `snap-${input.repositoryId}` };
        },
      },
    });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(RepositoryDiscoveryWorkflow, {
        taskQueue,
        workflowId: `test-discovery-${Date.now()}`,
        args: [{ repositoryId: 'repo-42' }],
      }),
    );

    expect(calls).toEqual([{ repositoryId: 'repo-42' }]);
    expect(result).toEqual({ repositoryId: 'repo-42', snapshotId: 'snap-repo-42' });
  }, 30_000);
});
