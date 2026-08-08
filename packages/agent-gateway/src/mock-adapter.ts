import { randomUUID } from 'node:crypto';
import type { AgentEvent, Finding } from '@awb/domain';
import type {
  AgentAssignment,
  AgentEventSink,
  AgentExecutionResult,
  AgentSession,
  CodingAgentAdapter,
  CreateAgentSessionInput,
} from './adapter.js';

export interface MockTurnScript {
  /** Emitted, in order, to the eventSink during execute(). */
  events?: AgentEvent[];
  findings?: Finding[];
  usage?: AgentExecutionResult['usage'];
  summary?: string;
  /** If true, execute() resolves with completed: false (simulates an interrupted/aborted turn). */
  interrupted?: boolean;
  /** If set, execute() rejects with this error (simulates a provider timeout/crash — a transient Activity-level failure, not a PhaseAttemptResult outcome). */
  throws?: Error;
  /** Simulated wall-clock delay before resolving, in ms — lets timeout-handling callers be tested without a real slow provider. */
  delayMs?: number;
}

/**
 * A fully deterministic, scriptable CodingAgentAdapter for automated tests. Scripts are queued
 * per taskId+role pair; each execute() call consumes the next queued
 * turn (or repeats the last one if the queue for that key is exhausted).
 */
export class MockAgentAdapter implements CodingAgentAdapter {
  readonly id = 'mock';

  private readonly scripts = new Map<string, MockTurnScript[]>();
  private readonly cursors = new Map<string, number>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly interruptedSessions = new Set<string>();

  private keyFor(taskId: string, role: string): string {
    return `${taskId}:${role}`;
  }

  /** Queues one or more scripted turns for a given (taskId, role) pair, consumed in order by successive execute() calls. */
  scriptTurns(taskId: string, role: string, ...turns: MockTurnScript[]): void {
    const key = this.keyFor(taskId, role);
    const existing = this.scripts.get(key) ?? [];
    this.scripts.set(key, [...existing, ...turns]);
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    const session: AgentSession = {
      id: randomUUID(),
      role: input.role,
      taskId: input.taskId,
      providerId: this.id,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async execute(
    session: AgentSession,
    _assignment: AgentAssignment,
    eventSink: AgentEventSink,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    if (signal.aborted) {
      return { completed: false, findings: [], summary: 'aborted before start' };
    }

    const key = this.keyFor(session.taskId, session.role);
    const queue = this.scripts.get(key) ?? [];
    const cursor = this.cursors.get(key) ?? 0;
    const turn = queue[Math.min(cursor, queue.length - 1)] ?? {};
    this.cursors.set(key, cursor + 1);

    if (turn.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
    }

    if (signal.aborted || this.interruptedSessions.has(session.id)) {
      return { completed: false, findings: [], summary: 'interrupted during execution' };
    }

    if (turn.throws) {
      throw turn.throws;
    }

    for (const event of turn.events ?? []) {
      eventSink(event);
    }
    if (turn.usage) {
      eventSink({ type: 'usage', usage: turn.usage });
    }

    return {
      completed: !turn.interrupted,
      findings: turn.findings ?? [],
      usage: turn.usage,
      summary: turn.summary ?? `mock turn ${cursor + 1} for ${session.role}`,
      // Deterministic resume token so the resume round-trip is testable on the mock runtime.
      sessionId: `mock-session-${session.taskId}-${session.role}`,
    };
  }

  async interrupt(session: AgentSession): Promise<void> {
    this.interruptedSessions.add(session.id);
  }

  async dispose(session: AgentSession): Promise<void> {
    this.sessions.delete(session.id);
    this.interruptedSessions.delete(session.id);
  }
}
