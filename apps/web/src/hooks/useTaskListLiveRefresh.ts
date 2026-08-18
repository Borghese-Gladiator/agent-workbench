import { useEffect } from 'react';
import { openEventStream } from '../api/events.js';
import { useDebouncedRefresh } from './useDebouncedRefresh.js';

/**
 * Drives the tasks list live off the existing semantic-event stream. The daemon WebSocket
 * pushes every run's events, so any event means some task advanced — we debounce-refresh the list
 * instead of waiting for the poll. Reuses `openEventStream` (which owns reconnect); it does
 * NOT add a second realtime mechanism. `onChange` is called on the trailing edge of an event burst.
 */
export function useTaskListLiveRefresh(onChange: () => void): void {
  const scheduleRefresh = useDebouncedRefresh(onChange);

  useEffect(() => {
    const close = openEventStream({
      onEvent: scheduleRefresh,
      // A (re)connect can mean we were disconnected across a status change — refresh to catch up.
      onOpen: scheduleRefresh,
    });

    return close;
  }, [scheduleRefresh]);
}
