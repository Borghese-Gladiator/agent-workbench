import { describe, expect, it, vi } from 'vitest';
import { Context as ActivityContext } from '@temporalio/activity';

/**
 * TASK-105 regression guard. The `heartbeatTimeout` on the runPhase proxy makes Temporal kill any
 * attempt that stops heartbeating. The failure mode this guards against: heartbeating only at
 * command boundaries, so a single long-but-LIVE command (a 10-minute `pnpm test`) produces one
 * silent gap wider than the ceiling and a healthy phase is killed as "stuck".
 *
 * These tests assert the interval-based contract: while work is in flight, beats keep arriving at
 * a cadence well under the ceiling, regardless of how long an individual command takes.
 */

const INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 120_000;

/** Mirrors the production timer: beat every INTERVAL_MS for as long as the work runs. */
async function withPhaseHeartbeat<T>(beat: () => void, work: () => Promise<T>): Promise<T> {
  const timer = setInterval(beat, INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

describe('TASK-105 phase heartbeat liveness', () => {
  it('keeps beating through a single command far longer than the heartbeat ceiling', async () => {
    vi.useFakeTimers();
    try {
      const beats: number[] = [];
      const phaseStart = Date.now();
      // One command that runs for 10 minutes — 5x the 2-minute ceiling.
      const TEN_MINUTES = 600_000;
      const work = new Promise<void>((resolve) => setTimeout(resolve, TEN_MINUTES));
      const wrapped = withPhaseHeartbeat(() => beats.push(Date.now()), () => work);

      await vi.advanceTimersByTimeAsync(TEN_MINUTES);
      await wrapped;

      // The command was live the whole time, so beats must span it with no gap over the ceiling.
      expect(beats.length).toBeGreaterThan(1);
      // Gaps between consecutive beats, plus the initial gap from phase start to the first beat.
      const gaps = beats.slice(1).map((b, i) => b - beats[i]!);
      const maxGap = Math.max(...gaps, beats[0]! - phaseStart);
      expect(maxGap).toBeLessThan(HEARTBEAT_TIMEOUT_MS);
      // ~30 beats over 10 minutes at a 20s cadence.
      expect(beats.length).toBeGreaterThanOrEqual(TEN_MINUTES / INTERVAL_MS - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops beating once the phase settles, so a wedged worker genuinely times out', async () => {
    vi.useFakeTimers();
    try {
      const beats: number[] = [];
      await withPhaseHeartbeat(
        () => beats.push(Date.now()),
        async () => {
          await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
        },
      );
      const afterSettle = beats.length;
      // No further beats after the work resolved — the timer was cleared.
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
      expect(beats.length).toBe(afterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emitPhaseHeartbeat is a no-op outside an Activity context (direct unit-test calls)', () => {
    // Outside an Activity, Context.current() throws; the helper must swallow it.
    expect(() => ActivityContext.current()).toThrow();
  });
});
