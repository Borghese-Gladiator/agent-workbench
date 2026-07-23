/**
 * Semantic-event stream client (TASK-23). The browser talks only to the daemon's `/api` — the live
 * WebSocket for new events, and the REST catch-up route to backfill anything missed while
 * disconnected (spec §31). Local type mirror; the browser never imports `packages/*`.
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

/** Opens the live WebSocket. Returns a close fn; caller wires onEvent/onOpen/onClose. */
export function openEventStream(handlers: {
  onEvent: (event: SemanticEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
}): () => void {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${window.location.host}/api/events/stream`);
  socket.addEventListener('open', () => handlers.onOpen?.());
  socket.addEventListener('message', (ev) => {
    try {
      handlers.onEvent(JSON.parse(ev.data as string) as SemanticEvent);
    } catch {
      // ignore malformed frames
    }
  });
  socket.addEventListener('close', () => handlers.onClose?.());
  return () => socket.close();
}
