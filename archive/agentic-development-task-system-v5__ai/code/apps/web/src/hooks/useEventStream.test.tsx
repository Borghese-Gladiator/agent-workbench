import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SemanticEvent } from '../api/events.js';
import { useEventStream } from './useEventStream.js';

// Control the event-stream client from the test: capture the handlers openEventStream is called with
// so we can drive open/close/message, and stub the REST catch-up.
const openHandlers: {
  onEvent: (e: SemanticEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
}[] = [];
const closeSpy = vi.fn();

vi.mock('../api/events.js', () => ({
  fetchEventsAfter: vi.fn(),
  openEventStream: (handlers: (typeof openHandlers)[number]) => {
    openHandlers.push(handlers);
    return closeSpy;
  },
}));

import { fetchEventsAfter } from '../api/events.js';

const fetchMock = vi.mocked(fetchEventsAfter);

/** The handlers passed to the most recent openEventStream call (throws if the hook never subscribed). */
function latestHandlers(): (typeof openHandlers)[number] {
  const h = openHandlers[openHandlers.length - 1];
  if (!h) throw new Error('openEventStream was not called');
  return h;
}

function ev(runId: string, sequence: number): SemanticEvent {
  return {
    id: `e${sequence}`,
    runId,
    sequence,
    occurredAt: '2026-08-04T00:00:00.000Z',
    phase: 'plan',
    phaseAttemptId: `${runId}-plan-1`,
    producer: 'planner',
    type: 'phase-started',
    summary: `event ${sequence}`,
  };
}

beforeEach(() => {
  openHandlers.length = 0;
  closeSpy.mockClear();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useEventStream', () => {
  const runId = 'task-1-run';

  it('backfills history on mount even when the socket never opens', async () => {
    fetchMock.mockResolvedValue([ev(runId, 0), ev(runId, 1), ev(runId, 2)]);

    const { result } = renderHook(() => useEventStream('task-1'));

    // Socket never fires onOpen; history must still render from the mount-time catch-up.
    await waitFor(() => expect(result.current.events).toHaveLength(3));
    expect(result.current.events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(result.current.status).toBe('connecting');
    expect(fetchMock).toHaveBeenCalledWith(runId, -1);
  });

  it('reconnect re-runs catch-up from the last sequence without duplicating events', async () => {
    // Mount backfill returns 0,1; the reconnect backfill returns 1,2 (1 overlaps and must dedupe).
    fetchMock.mockResolvedValueOnce([ev(runId, 0), ev(runId, 1)]);
    fetchMock.mockResolvedValueOnce([ev(runId, 1), ev(runId, 2)]);

    const { result } = renderHook(() => useEventStream('task-1'));
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    // Drop then reopen the socket.
    act(() => latestHandlers().onClose?.());
    expect(result.current.status).toBe('reconnecting');

    act(() => latestHandlers().onOpen?.());
    await waitFor(() => expect(result.current.events).toHaveLength(3));

    expect(result.current.status).toBe('connected');
    expect(result.current.events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    // The reconnect catch-up asked only for the tail after the highest seen sequence.
    expect(fetchMock).toHaveBeenLastCalledWith(runId, 1);
  });

  it('transitions connecting -> connected -> reconnecting', async () => {
    fetchMock.mockResolvedValue([]);
    const { result } = renderHook(() => useEventStream('task-1'));
    expect(result.current.status).toBe('connecting');

    act(() => latestHandlers().onOpen?.());
    expect(result.current.status).toBe('connected');

    act(() => latestHandlers().onClose?.());
    expect(result.current.status).toBe('reconnecting');
  });

  it('ignores events from other runs', async () => {
    fetchMock.mockResolvedValue([]);
    const { result } = renderHook(() => useEventStream('task-1'));
    await waitFor(() => expect(openHandlers).toHaveLength(1));

    act(() => latestHandlers().onEvent(ev('other-run', 5)));
    act(() => latestHandlers().onEvent(ev(runId, 0)));

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.events.map((e) => e.runId)).toEqual([runId]);
  });
});
