import { randomUUID } from 'node:crypto';
import type { AgentEvent, EventProducer, SemanticEvent, TaskPhase } from '@awb/domain';
import type { AgentSessionRole } from './adapter.js';

const ROLE_TO_PRODUCER: Record<AgentSessionRole, EventProducer> = {
  planner: 'planner',
  'plan-critic': 'plan-critic',
  builder: 'builder',
  verifier: 'verifier',
  'qa-executor': 'qa',
  'adversarial-reviewer': 'reviewer',
};

function summarize(event: AgentEvent): string {
  switch (event.type) {
    case 'intent':
      return event.summary;
    case 'plan-updated':
      return `plan updated (${event.steps.length} step(s))`;
    case 'tool-started':
      return `tool started: ${event.tool} — ${event.inputSummary}`;
    case 'tool-completed':
      return `tool completed: ${event.tool} — ${event.resultSummary}`;
    case 'command-started':
      return `command started: ${event.summary}`;
    case 'command-completed':
      return `command completed (exit ${event.exitCode})`;
    case 'file-changed':
      return `file changed: ${event.path}`;
    case 'finding':
      return 'finding reported';
    case 'usage':
      return `usage: ${event.usage.inputTokens} in / ${event.usage.outputTokens} out (${event.usage.model})`;
    case 'message':
      return event.text;
  }
}

const EVENT_TYPE_MAP: Record<AgentEvent['type'], SemanticEvent['type']> = {
  intent: 'intent',
  'plan-updated': 'status-changed',
  'tool-started': 'command-started',
  'tool-completed': 'command-completed',
  'command-started': 'command-started',
  'command-completed': 'command-completed',
  'file-changed': 'file-changed',
  finding: 'finding-created',
  usage: 'usage-reported',
  message: 'message',
};

/**
 * Converts a raw provider AgentEvent into a compact SemanticEvent row (product spec §19: "Do not
 * persist one Temporal event per token. Store raw provider streams as compressed artifacts. Store
 * semantic summaries in SQLite."). The raw event itself is never stored here — callers that need
 * the full payload keep it in `payloadJson` only when it's already small/structured (e.g. a
 * Finding), never a raw token stream.
 */
export function normalizeAgentEvent(input: {
  event: AgentEvent;
  runId: string;
  sequence: number;
  phase: TaskPhase;
  phaseAttemptId: string;
  role: AgentSessionRole;
}): SemanticEvent {
  return {
    id: randomUUID(),
    runId: input.runId,
    sequence: input.sequence,
    occurredAt: new Date().toISOString(),
    phase: input.phase,
    phaseAttemptId: input.phaseAttemptId,
    producer: ROLE_TO_PRODUCER[input.role],
    type: EVENT_TYPE_MAP[input.event.type],
    summary: summarize(input.event),
    payloadJson: input.event.type === 'finding' ? input.event.finding : undefined,
  };
}
