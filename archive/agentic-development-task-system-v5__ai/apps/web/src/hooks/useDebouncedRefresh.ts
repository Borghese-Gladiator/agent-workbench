import { useEffect, useRef } from 'react';

/** Coalesce bursts (a phase can emit several events at once) into a single trailing refresh. */
export const REFRESH_DEBOUNCE_MS = 300;

/**
 * Leading-guard debounce primitive. Returns a stable `schedule()` that, while a timer is already
 * pending, is a no-op — so a burst of calls collapses into a single trailing-edge `refresh()` after
 * `delayMs`. The pending timer is cleared on unmount. `refresh` is read through a ref so callers can
 * pass a fresh closure each render without re-arming anything.
 */
export function useDebouncedRefresh(
  refresh: () => void,
  delayMs: number = REFRESH_DEBOUNCE_MS,
): () => void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRef = useRef<() => void>(() => {});

  scheduleRef.current = () => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      refreshRef.current();
    }, delayMs);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, []);

  // Stable identity so effects/subscriptions depending on `schedule` don't re-run each render.
  const stableSchedule = useRef((): void => scheduleRef.current());
  return stableSchedule.current;
}
