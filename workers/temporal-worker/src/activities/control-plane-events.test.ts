import { describe, expect, it } from 'vitest';
import type { SemanticEvent } from '@awb/domain';
import { createControlPlaneEmitter } from './control-plane-events.js';
import type { DaemonClient } from '../daemon-client.js';

/** A DaemonClient that captures every posted SemanticEvent; the other writes are no-ops for this test. */
function capturingDaemon(): { daemon: DaemonClient; posted: SemanticEvent[] } {
  const posted: SemanticEvent[] = [];
  const daemon: DaemonClient = {
    async upsertTask() {},
    async saveRunState() {},
    async postEvent(event) {
      posted.push(event);
    },
    async postObservability() {},
    async refreshRepository() {
      return { snapshotId: 'snap' };
    },
  };
  return { daemon, posted };
}

describe('control-plane events (TASK-34)', () => {
  it('emits phase-started with the cwd and resume key as workbench-produced events', async () => {
    const { daemon, posted } = capturingDaemon();
    const emitter = createControlPlaneEmitter({ taskId: 'task-1', phase: 'implement', attemptNumber: 1, daemon });

    await emitter.phaseStarted({ cwd: '/tmp/worktree', resumeKey: 'slice-1' });

    expect(posted).toHaveLength(1);
    const [event] = posted;
    expect(event?.producer).toBe('workbench');
    expect(event?.type).toBe('phase-started');
    expect(event?.phase).toBe('implement');
    expect((event?.payloadJson as { cwd?: string }).cwd).toBe('/tmp/worktree');
  });

  it('emits phase-failed AND attempt-retry-scheduled when a retry is coming', async () => {
    const { daemon, posted } = capturingDaemon();
    const emitter = createControlPlaneEmitter({ taskId: 'task-1', phase: 'implement', attemptNumber: 1, daemon });

    await emitter.phaseFailed({
      errorClass: 'transport-drop',
      message: 'Connection closed mid-response',
      resumable: true,
      retryScheduled: true,
    });

    const types = posted.map((e) => e.type);
    expect(types).toEqual(['phase-failed', 'attempt-retry-scheduled']);
    expect((posted[0]?.payloadJson as { resumable?: boolean }).resumable).toBe(true);
  });

  it('emits only phase-failed (no retry) when attempts are exhausted', async () => {
    const { daemon, posted } = capturingDaemon();
    const emitter = createControlPlaneEmitter({ taskId: 'task-1', phase: 'implement', attemptNumber: 1, daemon });

    await emitter.phaseFailed({
      errorClass: 'phase-error',
      message: 'no accepted plan',
      resumable: false,
      retryScheduled: false,
    });

    expect(posted.map((e) => e.type)).toEqual(['phase-failed']);
  });

  it('distinguishes a resumed session from a cold start', async () => {
    const { daemon, posted } = capturingDaemon();
    const emitter = createControlPlaneEmitter({ taskId: 'task-1', phase: 'implement', attemptNumber: 2, daemon });

    await emitter.sessionResumed({ role: 'builder', cwd: '/tmp/worktree', resumeKey: 'slice-1' });
    await emitter.sessionStarted({ role: 'builder', cwd: '/tmp/worktree', resumeKey: 'slice-2' });

    expect(posted.map((e) => e.type)).toEqual(['session-resumed', 'session-started']);
  });

  it('is a no-op with no daemon (mock runtime persists nothing)', async () => {
    const emitter = createControlPlaneEmitter({ taskId: 'task-1', phase: 'implement', attemptNumber: 1 });
    // Should not throw even though there is no daemon to post to.
    await emitter.phaseStarted({ cwd: '/tmp/worktree' });
    await emitter.phaseFailed({ errorClass: 'x', message: 'y', resumable: false, retryScheduled: false });
  });
});
