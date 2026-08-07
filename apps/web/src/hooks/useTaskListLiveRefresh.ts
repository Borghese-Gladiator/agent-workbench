import { useEffect, useRef } from 'react';
import { openEventStream } from '../api/events.js';

// Coalesce bursts of events (a phase can emit several at once) into a single refresh.
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Drives the tasks list live off the existing semantic-event stream (TASK-49). The daemon WebSocket
 * pushes every run's events, so any event means some task advanced — we debounce-refresh the list
 * instead of waiting for the poll. Reuses `openEventStream` (which owns reconnect, TASK-57); it does
 * NOT add a second realtime mechanism. `onChange` is called on the trailing edge of an event burst.
 */
export function useTaskListLiveRefresh(onChange: () => void): void {
  // Keep the latest callback without re-subscribing the socket on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        onChangeRef.current();
      }, REFRESH_DEBOUNCE_MS);
    };

    const close = openEventStream({
      onEvent: scheduleRefresh,
      // A (re)connect can mean we were disconnected across a status change — refresh to catch up.
      onOpen: scheduleRefresh,
    });

    return () => {
      if (timer) clearTimeout(timer);
      close();
    };
  }, []);
}
