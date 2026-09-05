import { describe, expect, it } from 'vitest';
import type { PhaseObservability } from '@awb/domain';
import type { TaskWorkflowState } from '@awb/workflow';
import { drivePhase, UsageAccumulator, NOOP_PHASE_EVENT_EMITTER, type PhaseContext, type PhaseHandler } from './phase-driver.js';
import { ObservabilityAccumulator } from './observability-accumulator.js';
import type { DaemonClient } from '../daemon-client.js';
import type { RunStateStore, TaskRunState } from './run-state-store.js';
import type { RuntimeProfile } from './agent-factory.js';

const TASK_ID = 'task-1';

const state = (): TaskWorkflowState => ({
  taskId: TASK_ID,
  repositoryId: 'repo-1',
  phase: 'plan',
  condition: 'running',
  deliveryState: 'not-started',
  attemptNumber: 1,
  latestCandidateEvidenceIds: [],
  openFindingIds: [],
  tokenUsageTotal: { inputTokens: 0, outputTokens: 0 },
  runtimeMsByPhase: {},
});

/** Captures what the driver posts, so a test can assert the attempt was closed. */
function recordingDaemon(): { client: DaemonClient; posted: PhaseObservability[] } {
  const posted: PhaseObservability[] = [];
  const client = {
    postObservability: async (payload: PhaseObservability) => {
      posted.push(payload);
    },
  } as unknown as DaemonClient;
  return { client, posted };
}

function context(daemon: DaemonClient): PhaseContext {
  const runState: TaskRunState = {} as TaskRunState;
  return {
    state: state(),
    runState,
    store: { save: async () => {}, load: async () => runState, remove: async () => {} } as unknown as RunStateStore,
    strategy: 'mock',
    profile: {} as RuntimeProfile,
    usage: new UsageAccumulator(),
    emit: NOOP_PHASE_EVENT_EMITTER,
    observability: new ObservabilityAccumulator(),
    daemon,
  };
}

const earlyHandler = (outcome: PhaseHandler): PhaseHandler => outcome;

describe('drivePhase closes the phase attempt (TASK-124)', () => {
  it('posts the result outcome and a real end timestamp on the normal path', async () => {
    const { client, posted } = recordingDaemon();
    const handler: PhaseHandler = {
      phase: 'plan',
      run: async () => ({
        kind: 'early',
        result: {
          outcome: 'await-human',
          gate: {
            id: 'gate-1',
            taskId: TASK_ID,
            phase: 'plan',
            reason: 'task-contract-approval',
            summary: 'approve the contract',
            createdAt: '2026-09-04T00:00:00.000Z',
          },
        },
      }),
    };

    const result = await drivePhase(handler, context(client));

    expect(result.outcome).toBe('await-human');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.outcome).toBe('await-human');
    expect(posted[0]?.phaseAttemptId).toBe(`${TASK_ID}-plan-1`);
    expect(posted[0]?.endedAt).toBeDefined();
    expect(Date.parse(posted[0]!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(posted[0]!.startedAt!));
  });

  it('closes the attempt as failed when the handler throws, and re-throws', async () => {
    const { client, posted } = recordingDaemon();
    const boom = new Error('worktree vanished');
    const handler: PhaseHandler = {
      phase: 'plan',
      run: async () => {
        throw boom;
      },
    };

    await expect(drivePhase(handler, context(client))).rejects.toThrow('worktree vanished');

    expect(posted).toHaveLength(1);
    expect(posted[0]?.outcome).toBe('failed');
    expect(posted[0]?.endedAt).toBeDefined();
  });

  it('never lets a failed observability post change what the phase returned', async () => {
    const client = {
      postObservability: async () => {
        throw new Error('daemon down');
      },
    } as unknown as DaemonClient;
    const handler: PhaseHandler = {
      phase: 'plan',
      run: async () => ({ kind: 'early', result: { outcome: 'blocked', reason: 'nope' } }),
    };

    await expect(drivePhase(handler, context(client))).resolves.toMatchObject({ outcome: 'blocked' });
  });

  it('never lets a failed observability post mask the handler error', async () => {
    const client = {
      postObservability: async () => {
        throw new Error('daemon down');
      },
    } as unknown as DaemonClient;
    const handler: PhaseHandler = {
      phase: 'plan',
      run: async () => {
        throw new Error('real cause');
      },
    };

    await expect(drivePhase(handler, context(client))).rejects.toThrow('real cause');
  });

  it('posts nothing when there is no daemon — the mock path has nothing to persist', async () => {
    const ctx = context(recordingDaemon().client);
    delete ctx.daemon;
    const handler = earlyHandler({
      phase: 'plan',
      run: async () => ({ kind: 'early', result: { outcome: 'blocked', reason: 'nope' } }),
    });

    await expect(drivePhase(handler, ctx)).resolves.toMatchObject({ outcome: 'blocked' });
  });
});
