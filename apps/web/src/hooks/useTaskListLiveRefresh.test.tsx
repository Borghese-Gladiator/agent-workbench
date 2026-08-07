import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SemanticEvent } from '../api/events.js';
import { useTaskListLiveRefresh } from './useTaskListLiveRefresh.js';

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

function latestHandlers(): (typeof openHandlers)[number] {
  const h = openHandlers[openHandlers.length - 1];
  if (!h) throw new Error('openEventStream was not called');
  return h;
}

function ev(sequence: number): SemanticEvent {
  return {
    id: `e${sequence}`,
    runId: 'task-1-run',
    sequence,
    occurredAt: '2026-08-04T00:00:00.000Z',
    phase: 'plan',
    phaseAttemptId: 'task-1-plan-1',
    producer: 'planner',
    type: 'phase-started',
    summary: 'x',
  };
}

beforeEach(() => {
  openHandlers.length = 0;
  closeSpy.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTaskListLiveRefresh', () => {
  it('debounces a burst of events into a single refresh', () => {
    const onChange = vi.fn();
    renderHook(() => useTaskListLiveRefresh(onChange));

    act(() => {
      latestHandlers().onEvent(ev(0));
      latestHandlers().onEvent(ev(1));
      latestHandlers().onEvent(ev(2));
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('refreshes on (re)connect', () => {
    const onChange = vi.fn();
    renderHook(() => useTaskListLiveRefresh(onChange));

    act(() => latestHandlers().onOpen?.());
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('closes the stream on unmount', () => {
    const { unmount } = renderHook(() => useTaskListLiveRefresh(vi.fn()));
    unmount();
    expect(closeSpy).toHaveBeenCalled();
  });
});
