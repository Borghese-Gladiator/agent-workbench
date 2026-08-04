/**
 * Semantic-event stream client (TASK-23). The browser talks only to the daemon's `/api` — the live
 * WebSocket for new events, and the REST catch-up route to backfill anything missed while
 * disconnected (spec §31). Local type mirror; the browser never imports `packages/*`.
 *
 * The WebSocket is not run-scoped: it pushes every run's events, so a single subscription can drive
 * both the per-task timeline (filtered by runId) and the tasks-list live refresh (any event).
 * `openEventStream` owns reconnection — on close/error it backs off and re-opens, re-invoking
 * `onOpen` each time so callers can re-run catch-up (dedupe-by-sequence keeps that gap-free).
 */

export interface SemanticEvent {
  id: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  phase: string;
  phaseAttemptId: string;
  producer: string;
  type: string;
  summary: string;
  payloadJson?: unknown;
  artifactId?: string;
}

/** REST catch-up: events for a run with sequence > afterSequence, in order (spec §31). */
export async function fetchEventsAfter(runId: string, afterSequence: number): Promise<SemanticEvent[]> {
  const params = new URLSearchParams({ runId, afterSequence: String(afterSequence) });
  const response = await fetch(`/api/events?${params.toString()}`);
  if (!response.ok) return [];
  const json = (await response.json().catch(() => ({}))) as { events?: SemanticEvent[] };
  return json.events ?? [];
}

// Reconnect backoff: start small, grow, cap. Kept short so a restarted daemon reconnects quickly.
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/**
 * Opens the live WebSocket and keeps it open, reconnecting on drop. Returns a close fn that stops
 * reconnecting and closes the current socket. `onOpen` fires on every (re)connect so the caller can
 * re-run catch-up; `onClose` fires on every drop so the caller can reflect a "reconnecting" state.
 */
export function openEventStream(handlers: {
  onEvent: (event: SemanticEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
}): () => void {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let backoff = RECONNECT_MIN_MS;

  const connect = () => {
    if (stopped) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${window.location.host}/api/events/stream`);

    socket.addEventListener('open', () => {
      backoff = RECONNECT_MIN_MS;
      handlers.onOpen?.();
    });
    socket.addEventListener('message', (ev) => {
      try {
        handlers.onEvent(JSON.parse(ev.data as string) as SemanticEvent);
      } catch {
        // ignore malformed frames
      }
    });
    const scheduleReconnect = () => {
      if (stopped) return;
      handlers.onClose?.();
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };
    // A failed handshake fires 'error' then 'close'; a dropped live socket fires 'close'. Reconnect
    // from 'close' only so we schedule exactly one retry per lost connection.
    socket.addEventListener('close', scheduleReconnect);
  };

  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
  };
}
