/**
 * The one piece of real logic in this package: block until a task's in-flight
 * agent run reaches a terminal state, riding the daemon's per-run SSE stream
 * (which the daemon end()s exactly when the run succeeds/fails). Ported from
 * scripts/lib/driver-core.mjs `waitForRunToFinish` — the MCP now owns this so the
 * demo can call it as a tool instead of reimplementing the SSE/fallback dance.
 *
 * The client deliberately exposes only `runEventsUrl()` (a URL string), not a
 * stream consumer, so consumption lives here.
 *
 * Never throws: any SSE failure degrades to 'fallback' so the caller can poll.
 * The daemon drops sockets under load (see ECONNRESET history), so SSE is a
 * latency optimization, never a correctness dependency.
 */
import type { WorkbenchClient } from '@workbench/client';

export type WaitOutcome =
  /** The active run's SSE stream closed — the run hit a terminal state. */
  | 'finished'
  /** There was no active run to wait on (caller should just read state). */
  | 'idle'
  /** SSE was unavailable / errored / timed out — caller MUST fall back to polling. */
  | 'fallback';

export interface WaitForRunOptions {
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve when the task's currently active agent run finishes (via SSE), or with
 * 'idle'/'fallback' if there's no live stream to ride.
 */
export async function waitForRun(
  client: WorkbenchClient,
  taskId: string,
  { timeoutMs = 30 * 60_000, fetchImpl = fetch }: WaitForRunOptions = {},
): Promise<WaitOutcome> {
  let runId: string | undefined;
  try {
    const { run } = await client.getActiveRun(taskId);
    runId = run?.id;
  } catch {
    return 'fallback';
  }
  if (!runId) return 'idle';

  const url = client.runEventsUrl(taskId, runId);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) return 'fallback';
    // Drain the stream to its end. The daemon res.end()s on the run's terminal
    // event, so the reader simply runs dry — we don't need to parse events.
    const reader = res.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    return 'finished';
  } catch {
    // Aborted (timeout) or socket dropped mid-stream — let the caller poll.
    return 'fallback';
  } finally {
    clearTimeout(timer);
  }
}
