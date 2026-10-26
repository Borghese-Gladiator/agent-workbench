import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@awb/domain';
import type { AgentEventSink } from '@awb/agent-gateway';

/**
 * A per-task, per-role agent event sink that persists every event an agent session emits — its
 * text messages, tool-use/tool-result events, and usage — to a newline-delimited JSON log file
 * under the task's artifacts dir. Before this, every session used NOOP_EVENT_SINK, so when
 * the plan phase stalled (`repeated-failure-no-progress`) the planner/critic's actual output was
 * discarded and the stall was uninspectable. The log file makes it possible to read exactly what
 * the planner emitted (e.g. whether it produced the fenced JSON plan block) after a stall.
 */
export function createFileEventSink(input: {
  artifactsDir: string;
  taskId: string;
  role: string;
  phaseAttempt: string;
}): { sink: AgentEventSink; logPath: string } {
  const dir = join(input.artifactsDir, 'agent-logs');
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `${input.phaseAttempt}-${input.role}.ndjson`);

  const sink: AgentEventSink = (event: AgentEvent) => {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      role: input.role,
      event: summarizeEvent(event),
    });
    try {
      appendFileSync(logPath, line + '\n');
    } catch {
      // Logging is best-effort — a failed write must never break the agent turn it is observing.
    }
  };

  return { sink, logPath };
}

/**
 * Collapses an AgentEvent to a compact, log-friendly record. Tool inputs/results and message text
 * can be large; they are truncated so the log stays readable while preserving enough to diagnose a
 * stall (was JSON emitted? which tool ran? did it error?).
 */
function summarizeEvent(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case 'message':
      return { type: 'message', text: truncate(event.text, 4000) };
    case 'tool-started':
      return { type: 'tool-started', tool: event.tool, input: truncate(event.inputSummary, 1000) };
    case 'tool-completed':
      return { type: 'tool-completed', tool: event.tool, result: truncate(event.resultSummary, 1000) };
    case 'usage':
      return { type: 'usage', usage: event.usage };
    case 'intent':
      return { type: 'intent', summary: truncate(event.summary, 1000) };
    case 'file-changed':
      return { type: 'file-changed', path: event.path };
    case 'command-started':
      return { type: 'command-started', commandId: event.commandId, summary: truncate(event.summary, 500) };
    case 'command-completed':
      return { type: 'command-completed', commandId: event.commandId, exitCode: event.exitCode };
    default:
      return { type: event.type };
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text;
}
