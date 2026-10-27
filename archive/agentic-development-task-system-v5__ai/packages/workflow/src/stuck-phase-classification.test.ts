import { describe, expect, it } from 'vitest';
import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  RetryState,
  ServerFailure,
  TerminatedFailure,
  TimeoutFailure,
} from '@temporalio/common';
import { isRetryableStuckPhase, isHeartbeatTimeout } from './task-workflow.js';

/**
 * TASK-105: the runPhase catch folds an exhausted Activity failure into the no-progress streak so a
 * stuck phase escalates instead of silently replaying. That must NOT swallow control flow — a
 * cancelled or terminated workflow has to unwind, not look like a repair and spin the phase loop.
 *
 * Temporal always wraps the real reason as `ActivityFailure.cause`, so these assert the cause chain
 * is unwrapped rather than only the outermost error being inspected.
 */

/** Mirrors how Temporal hands an Activity failure to the workflow: wrapped, with the reason as cause. */
function wrapAsActivityFailure(cause: Error): ActivityFailure {
  return new ActivityFailure('Activity task failed', 'runPhase', '1', RetryState.MAXIMUM_ATTEMPTS_REACHED, 'worker', cause);
}

describe('isRetryableStuckPhase', () => {
  it('treats a HEARTBEAT timeout as stuck — the hung-command case TASK-105 exists for', () => {
    const err = wrapAsActivityFailure(new TimeoutFailure('activity timeout', undefined, 'HEARTBEAT'));
    expect(isRetryableStuckPhase(err)).toBe(true);
    expect(isHeartbeatTimeout(err)).toBe(true);
  });

  it('treats a START_TO_CLOSE timeout as stuck, but not as a heartbeat timeout', () => {
    const err = wrapAsActivityFailure(new TimeoutFailure('activity timeout', undefined, 'START_TO_CLOSE'));
    expect(isRetryableStuckPhase(err)).toBe(true);
    expect(isHeartbeatTimeout(err)).toBe(false);
  });

  it('treats an ApplicationFailure the phase threw as stuck (a real execution failure)', () => {
    expect(isRetryableStuckPhase(wrapAsActivityFailure(ApplicationFailure.create({ message: 'boom' })))).toBe(true);
  });

  it('treats an infrastructure ServerFailure as stuck', () => {
    expect(isRetryableStuckPhase(wrapAsActivityFailure(new ServerFailure('server blip', true)))).toBe(true);
  });

  it('treats a plain Error as stuck', () => {
    expect(isRetryableStuckPhase(wrapAsActivityFailure(new Error('process crashed')))).toBe(true);
  });

  // The control-flow cases: these must propagate so the workflow unwinds.
  it('does NOT treat a wrapped CancelledFailure as stuck — cancellation is control flow', () => {
    const err = wrapAsActivityFailure(new CancelledFailure('cancelled'));
    expect(isRetryableStuckPhase(err)).toBe(false);
  });

  it('does NOT treat a bare CancelledFailure as stuck', () => {
    expect(isRetryableStuckPhase(new CancelledFailure('cancelled'))).toBe(false);
  });

  it('does NOT treat a wrapped TerminatedFailure as stuck — nothing left to repair', () => {
    expect(isRetryableStuckPhase(wrapAsActivityFailure(new TerminatedFailure('terminated')))).toBe(false);
  });

  it('finds a CancelledFailure nested deeper than one level in the cause chain', () => {
    const deep = wrapAsActivityFailure(new ApplicationFailure('outer', 'Err', false, undefined, new CancelledFailure('cancelled')));
    expect(isRetryableStuckPhase(deep)).toBe(false);
  });

  it('terminates on a cyclic cause chain instead of looping forever', () => {
    const a = new Error('a');
    const b = new Error('b');
    (a as Error & { cause?: unknown }).cause = b;
    (b as Error & { cause?: unknown }).cause = a;
    expect(isRetryableStuckPhase(a)).toBe(true);
    expect(isHeartbeatTimeout(a)).toBe(false);
  });

  it('handles non-Error throwables without crashing', () => {
    expect(isRetryableStuckPhase('a string')).toBe(true);
    expect(isRetryableStuckPhase(undefined)).toBe(true);
    expect(isHeartbeatTimeout(null)).toBe(false);
  });
});
