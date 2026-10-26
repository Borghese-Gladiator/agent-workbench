import type { AgentEvent, TaskPhase, SemanticEvent } from '@awb/domain';
import { normalizeAgentEvent, type AgentEventSink, type AgentSessionRole } from '@awb/agent-gateway';
import { runIdForTask } from '@awb/database';
import type { DaemonClient } from '../daemon-client.js';
import { createFileEventSink } from './event-sink-support.js';
import { createDaemonClient } from '../daemon-client.js';

/**
 * Durable, streaming agent-event sink. Each raw provider `AgentEvent` an agent session
 * emits is normalized into a compact `SemanticEvent` (never the raw token stream), stamped
 * with a monotonic per-run `sequence`, and POSTed to the daemon, which persists it to `semantic_events`
 * and republishes it on its in-process bus to any connected WebSocket client (the daemon owns the bus;
 * the worker reaches it over HTTP — single hop, no polling).
 *
 * `AgentEventSink` is synchronous, but the POST is async: events are enqueued and drained by a
 * serial pump (preserving order), and `flush()` awaits the queue so the caller can guarantee every
 * event is durable before the phase result is returned. The daemon assigns the authoritative per-run
 * `sequence` on write, so the worker sends a provisional 0.
 */
export function createDurableEventSink(input: {
  taskId: string;
  role: AgentSessionRole;
  phase: TaskPhase;
  attemptNumber: number;
  daemon: DaemonClient;
}): { sink: AgentEventSink; flush: () => Promise<void>; errors: Error[] } {
  const runId = runIdForTask(input.taskId);
  const phaseAttemptId = `${input.taskId}-${input.phase}-${input.attemptNumber}`;
  const errors: Error[] = [];

  // Serial pump: keeps events strictly ordered and lets flush() await the tail.
  let chain: Promise<void> = Promise.resolve();

  const sink: AgentEventSink = (event: AgentEvent) => {
    const semantic: SemanticEvent = normalizeAgentEvent({
      event,
      runId,
      sequence: 0, // provisional; the daemon assigns the authoritative per-run sequence on write
      phase: input.phase,
      phaseAttemptId,
      role: input.role,
    });
    chain = chain.then(async () => {
      try {
        await input.daemon.postEvent(semantic);
      } catch (err) {
        // Observability is best-effort: a dropped event must never fail the agent turn or the phase.
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  return { sink, flush: () => chain, errors };
}

/**
 * The per-agent-session sink used by every phase: fans each event to BOTH the NDJSON file log (the
 * existing local diagnostic, kept) AND the durable/streaming daemon sink. On the mock
 * runtime, or when no daemon is reachable, the durable sink's POST simply records an error and the
 * file sink still works — observability is best-effort and never fails the turn. Returns a `flush`
 * the caller awaits after `adapter.execute` so events are persisted before the phase result returns.
 */
export function createPhaseEventSink(input: {
  artifactsDir: string;
  taskId: string;
  role: AgentSessionRole;
  phase: TaskPhase;
  attemptNumber: number;
  /** When false (mock runtime), only the file sink runs — no daemon POSTs. */
  durable: boolean;
  daemon?: DaemonClient;
}): { sink: AgentEventSink; flush: () => Promise<void> } {
  const { sink: fileSink } = createFileEventSink({
    artifactsDir: input.artifactsDir,
    taskId: input.taskId,
    role: input.role,
    phaseAttempt: `${input.phase}-${input.attemptNumber}`,
  });

  if (!input.durable) {
    return { sink: fileSink, flush: async () => {} };
  }

  const durable = createDurableEventSink({
    taskId: input.taskId,
    role: input.role,
    phase: input.phase,
    attemptNumber: input.attemptNumber,
    daemon: input.daemon ?? createDaemonClient(),
  });

  const sink: AgentEventSink = (event: AgentEvent) => {
    fileSink(event);
    durable.sink(event);
  };

  return { sink, flush: durable.flush };
}
