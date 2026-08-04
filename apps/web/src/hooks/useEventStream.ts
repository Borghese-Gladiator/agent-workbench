import { useEffect, useRef, useState } from 'react';
import { fetchEventsAfter, openEventStream, type SemanticEvent } from '../api/events.js';

/** Connection state for the live timeline. `reconnecting` means the socket is down but any already
 * backfilled history is still shown — so a dead socket never reads as "no events". */
export type EventStreamStatus = 'connecting' | 'connected' | 'reconnecting';

/**
 * Live semantic-event timeline for a task (TASK-23 / spec §31, TASK-57). History is backfilled on
 * mount via `GET /api/events?afterSequence=N` — independent of the WebSocket, so stored events render
 * even if the socket never connects. The socket then delivers new events and, on every (re)connect,
 * re-runs catch-up to fill any gap. Events are deduped and kept ordered by `sequence`, so a
 * disconnect/reconnect leaves no gap and no duplicate.
 */
export function useEventStream(taskId: string | undefined): {
  events: SemanticEvent[];
  status: EventStreamStatus;
} {
  const runId = taskId ? `${taskId}-run` : undefined;
  const [events, setEvents] = useState<SemanticEvent[]>([]);
  const [status, setStatus] = useState<EventStreamStatus>('connecting');
  // Highest sequence seen, so a reconnect only backfills the true tail.
  const lastSeq = useRef(-1);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    if (!runId) return;
    lastSeq.current = -1;
    seen.current = new Set();
    setEvents([]);
    setStatus('connecting');

    let closed = false;

    const merge = (incoming: SemanticEvent[]) => {
      if (incoming.length === 0) return;
      setEvents((prev) => {
        const next = [...prev];
        for (const e of incoming) {
          if (e.runId !== runId || seen.current.has(e.sequence)) continue;
          seen.current.add(e.sequence);
          if (e.sequence > lastSeq.current) lastSeq.current = e.sequence;
          next.push(e);
        }
        next.sort((a, b) => a.sequence - b.sequence);
        return next;
      });
    };

    const catchUp = async () => {
      const missed = await fetchEventsAfter(runId, lastSeq.current);
      if (!closed) merge(missed);
    };

    // Backfill immediately on mount, independent of the socket — history must render even if the WS
    // never opens (TASK-57 defect 1).
    void catchUp();

    const close = openEventStream({
      onOpen: () => {
        if (closed) return;
        setStatus('connected');
        // Fill anything produced while we were (re)connecting.
        void catchUp();
      },
      onEvent: (event) => merge([event]),
      onClose: () => {
        if (!closed) setStatus('reconnecting');
      },
    });

    return () => {
      closed = true;
      close();
    };
  }, [runId]);

  return { events, status };
}
