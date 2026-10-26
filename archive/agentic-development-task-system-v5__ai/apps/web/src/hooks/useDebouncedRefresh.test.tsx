import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedRefresh } from './useDebouncedRefresh.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedRefresh', () => {
  it('coalesces a burst into a single trailing-edge call', () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useDebouncedRefresh(refresh));

    act(() => {
      result.current();
      result.current();
      result.current();
    });
    expect(refresh).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('always reads the latest refresh closure', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ fn }) => useDebouncedRefresh(fn), {
      initialProps: { fn: first },
    });

    rerender({ fn: second });
    act(() => result.current());
    act(() => vi.advanceTimersByTime(300));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps a stable schedule identity across renders', () => {
    const { result, rerender } = renderHook(() => useDebouncedRefresh(vi.fn()));
    const firstSchedule = result.current;
    rerender();
    expect(result.current).toBe(firstSchedule);
  });

  it('clears the pending timer on unmount', () => {
    const refresh = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedRefresh(refresh));

    act(() => result.current());
    unmount();
    act(() => vi.advanceTimersByTime(300));

    expect(refresh).not.toHaveBeenCalled();
  });
});
