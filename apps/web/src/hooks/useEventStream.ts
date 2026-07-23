import { useEffect, useRef, useState } from 'react';
import { fetchEventsAfter, openEventStream, type SemanticEvent } from '../api/events.js';

/**
 * Live semantic-event timeline for a task with reconnect catch-up (TASK-23 / spec §31). Opens the
 * daemon WebSocket for new events and, on every (re)connect, backfills anything missed since the
 * last sequence seen via `GET /api/events?afterSequence=N`. Events are deduped and kept ordered by
 * `sequence`, so a disconnect/reconnect leaves no gap in the timeline.
 */
export function useEventStream(taskId: string | undefined): {
  events: SemanticEvent[];
  connected: boolean;
} {
  const runId = taskId ? `${taskId}-run` : undefined;
  const [events, setEvents] = useState<SemanticEvent[]>([]);
  const [connected, setConnected] = useState(false);
  // Highest sequence seen, so a reconnect only backfills the true tail.
  const lastSeq = useRef(-1);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    if (!runId) return;
    lastSeq.current = -1;
    seen.current = new Set();
    setEvents([]);
    setConnected(false);

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

    const close = openEventStream({
      onOpen: () => {
        if (closed) return;
        setConnected(true);
        // Backfill anything produced while we were (re)connecting.
        void catchUp();
      },
      onEvent: (event) => merge([event]),
      onClose: () => {
        if (!closed) setConnected(false);
      },
    });

    return () => {
      closed = true;
      close();
    };
  }, [runId]);

  return { events, connected };
}
