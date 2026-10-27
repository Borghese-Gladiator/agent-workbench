import { describe, expect, it, vi } from 'vitest';
import type { Worker } from '@temporalio/worker';
import { superviseWorker } from './index.js';
import { isRetryableDaemonFailure, requestJson } from './daemon-client.js';

const noDelay = async (): Promise<void> => {};

/** A worker whose `run()` resolves or rejects on cue, standing in for the real poll loop. */
function fakeWorker(run: () => Promise<void>): Worker {
  return { run } as unknown as Worker;
}

// TASK-111: a WiFi outage left the temporal-worker idle for ~3h — backlog 0, pollers apparently
// alive, no workflow tasks executed — until an operator ran `awb restart worker`. A worker whose
// poll loop ends must rebuild itself.
describe('superviseWorker (TASK-111)', () => {
  it.each([
    { label: 'the poll loop resolves early', run: async (): Promise<void> => {} },
    { label: 'the poll loop rejects', run: async (): Promise<void> => { throw new Error('Connection closed mid-response'); } },
    { label: 'building the worker throws', run: undefined },
  ])('rebuilds the worker when $label', async ({ run }) => {
    let builds = 0;
    const restarts: string[] = [];
    await superviseWorker({
      build: async () => {
        builds += 1;
        if (!run) throw new Error('ConnectionRefused');
        return fakeWorker(run);
      },
      // Stop after three restarts so the test terminates; production runs until SIGTERM.
      shouldContinue: () => restarts.length < 3,
      delay: noDelay,
      onRestart: ({ reason }) => restarts.push(reason),
    });
    expect(builds).toBeGreaterThan(1);
    expect(restarts).toHaveLength(3);
  });

  // A clean shutdown and a partition look identical from inside the supervisor, so `shouldContinue`
  // is what separates them. Getting this wrong would make `awb down` spin instead of stopping.
  it('stops without rebuilding when asked to shut down', async () => {
    let builds = 0;
    let running = true;
    const restarts: unknown[] = [];
    await superviseWorker({
      build: async () => {
        builds += 1;
        return fakeWorker(async () => {
          running = false; // a SIGTERM arriving while the loop runs
        });
      },
      shouldContinue: () => running,
      delay: noDelay,
      onRestart: (info) => restarts.push(info),
    });
    expect(builds).toBe(1);
    expect(restarts).toEqual([]);
  });

  it('backs off further on each successive restart', async () => {
    const waits: number[] = [];
    const restarts: unknown[] = [];
    await superviseWorker({
      build: async () => fakeWorker(async () => {}),
      shouldContinue: () => restarts.length < 3,
      delay: async (ms) => {
        waits.push(ms);
      },
      onRestart: (info) => restarts.push(info),
    });
    expect(waits).toEqual([1000, 2000, 4000]);
  });
});

// TASK-111: after the partition the workflow history advanced while SQLite stayed frozen —
// phase_attempts stuck at `specify|1|open`, semantic_events max sequence 0. A daemon restart takes
// seconds; retrying across it turns a permanently-behind database into a short pause.
describe('daemon write retry (TASK-111)', () => {
  it.each([
    { label: 'a refused connection', message: 'daemon PUT /internal/tasks/t failed to connect: ECONNREFUSED', expected: true },
    { label: 'a 503 while the daemon restarts', message: 'daemon POST /internal/events returned 503: ', expected: true },
    { label: 'a 500', message: 'daemon POST /internal/events returned 500: boom', expected: true },
    { label: 'a 400 malformed payload', message: 'daemon POST /internal/events returned 400: bad', expected: false },
    { label: 'a 404', message: 'daemon PUT /internal/tasks/t returned 404: ', expected: false },
  ])('treats $label as retryable=$expected', ({ message, expected }) => {
    expect(isRetryableDaemonFailure(new Error(message))).toBe(expected);
  });

  it('retries across a daemon restart and returns the eventual success', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('daemon PUT /internal/tasks/t failed to connect: ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('daemon PUT /internal/tasks/t returned 503: '))
      .mockResolvedValueOnce({ ok: true });
    const result = await requestJson('PUT', '/internal/tasks/t', {}, { send, delay: noDelay });
    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(3);
  });

  // A malformed payload fails identically forever; retrying only delays a real error.
  it('does not retry a permanent failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('daemon POST /internal/events returned 400: bad'));
    await expect(requestJson('POST', '/internal/events', {}, { send, delay: noDelay })).rejects.toThrow('400');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget and surfaces the last error', async () => {
    const send = vi.fn().mockRejectedValue(new Error('daemon PUT /x failed to connect: ECONNREFUSED'));
    await expect(requestJson('PUT', '/x', {}, { send, delay: noDelay, attempts: 3 })).rejects.toThrow('ECONNREFUSED');
    expect(send).toHaveBeenCalledTimes(3);
  });
});
