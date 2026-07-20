import type { WorkbenchClient } from '@workbench/client';
import { describe, expect, it, vi } from 'vitest';
import { waitForRun } from './wait.js';

/**
 * Minimal fake client exposing only what `waitForRun` touches: getActiveRun and
 * runEventsUrl. `activeRun` controls what getActiveRun resolves/throws.
 */
function fakeClient(opts: {
  activeRun?: { id: string } | null;
  activeThrows?: boolean;
}): WorkbenchClient {
  return {
    getActiveRun: vi.fn(async () => {
      if (opts.activeThrows) throw new Error('boom');
      return { run: opts.activeRun ?? null };
    }),
    runEventsUrl: (taskId: string, runId: string) =>
      `http://host:4417/api/tasks/${taskId}/agent/runs/${runId}/events`,
  } as unknown as WorkbenchClient;
}

/** A fetch whose body reader yields N chunks then closes (mimics an SSE stream). */
function streamFetch(chunks: number, { ok = true, hasBody = true } = {}) {
  let remaining = chunks;
  const body = hasBody
    ? {
        getReader: () => ({
          read: async () =>
            remaining-- > 0 ? { done: false, value: new Uint8Array() } : { done: true },
        }),
      }
    : null;
  return vi.fn(async () => ({ ok, body }) as unknown as Response) as unknown as typeof fetch;
}

describe('waitForRun', () => {
  it('returns "idle" when there is no active run', async () => {
    const client = fakeClient({ activeRun: null });
    expect(await waitForRun(client, 't1', { fetchImpl: streamFetch(0) })).toBe('idle');
  });

  it('returns "fallback" when getActiveRun throws', async () => {
    const client = fakeClient({ activeThrows: true });
    expect(await waitForRun(client, 't1', { fetchImpl: streamFetch(0) })).toBe('fallback');
  });

  it('returns "finished" when the SSE stream drains to done', async () => {
    const client = fakeClient({ activeRun: { id: 'run1' } });
    expect(await waitForRun(client, 't1', { fetchImpl: streamFetch(3) })).toBe('finished');
  });

  it('returns "fallback" on a non-ok SSE response', async () => {
    const client = fakeClient({ activeRun: { id: 'run1' } });
    const fetchImpl = streamFetch(0, { ok: false });
    expect(await waitForRun(client, 't1', { fetchImpl })).toBe('fallback');
  });

  it('returns "fallback" when the response has no body', async () => {
    const client = fakeClient({ activeRun: { id: 'run1' } });
    const fetchImpl = streamFetch(0, { hasBody: false });
    expect(await waitForRun(client, 't1', { fetchImpl })).toBe('fallback');
  });

  it('returns "fallback" when fetch throws (e.g. abort/socket drop)', async () => {
    const client = fakeClient({ activeRun: { id: 'run1' } });
    const fetchImpl = vi.fn(async () => {
      throw new Error('aborted');
    }) as unknown as typeof fetch;
    expect(await waitForRun(client, 't1', { fetchImpl })).toBe('fallback');
  });

  it('hits the run-events URL for the active run', async () => {
    const client = fakeClient({ activeRun: { id: 'run1' } });
    const fetchImpl = streamFetch(1);
    await waitForRun(client, 't1', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://host:4417/api/tasks/t1/agent/runs/run1/events',
      expect.objectContaining({ headers: { Accept: 'text/event-stream' } }),
    );
  });
});
