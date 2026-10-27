import { describe, expect, it } from 'vitest';
import type { TaskStateSync } from '@awb/domain';
import type { DaemonClient } from '../daemon-client.js';
import { syncTaskState } from './sync-task-state.js';

const STATE: TaskStateSync = {
  taskId: 'task-1',
  repositoryId: 'repo-1',
  prompt: 'do the thing',
  phase: 'implement',
  condition: 'running',
  deliveryState: 'not-started',
  pendingGateReason: null,
};

function fakeDaemon(overrides: Partial<DaemonClient> = {}): DaemonClient {
  return {
    async syncTaskState() {},
    async saveRunState() {},
    async postEvent() {},
    async postObservability() {},
    async refreshRepository() {
      return { snapshotId: 'snapshot-1' };
    },
    async notifyReleased() {},
    async persistStartCommand() {},
    ...overrides,
  };
}

describe('syncTaskState', () => {
  it('forwards the workflow state to the daemon', async () => {
    const written: TaskStateSync[] = [];
    await syncTaskState(
      STATE,
      fakeDaemon({
        async syncTaskState(state) {
          written.push(state);
        },
      }),
    );
    expect(written).toEqual([STATE]);
  });

  it('swallows a daemon failure so a monitoring write never fails the task', async () => {
    await expect(
      syncTaskState(
        STATE,
        fakeDaemon({
          async syncTaskState() {
            throw new Error('daemon PUT /internal/tasks/task-1 failed to connect: ECONNREFUSED');
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
