/**
 * QuestionGate — the daemon-side mid-run human-input gate.
 *
 * When an agent run needs a human answer (a deliberate question, or a
 * tool-permission decision routed through the MCP `workbench_ask` tool), the
 * gate: persists an AgentQuestion, flips the run to `awaiting_input`, emits an
 * `ask_question` event, and returns a promise that resolves when the human
 * answers via the answer endpoint. Resolving flips the run back to `running`
 * and emits `question_answered`.
 *
 * This is the single funnel for BOTH paths:
 * - mock adapter: calls `ask()` in-process via its `requestInput` handler.
 * - real claude CLI: the spawned MCP server relays the tool call over HTTP to
 *   the daemon, which calls `ask()` and holds the HTTP response open until the
 *   promise resolves.
 *
 * Pending promises live only in memory: a run still `awaiting_input` when the
 * daemon restarts is swept to `interrupted` on boot and its conversation is a
 * candidate for resume under a new run (see Store.markInterruptedRuns +
 * boot-reconcile).
 */

import type { AgentQuestionRequest } from '@workbench/agents';
import type { AgentQuestion, AgentQuestionAnswer } from '@workbench/core';
import type { Store } from '@workbench/store';

/** Emit hooks so the gate can stream events without owning the bus. */
export interface GateEmitter {
  emit(runId: string, type: 'ask_question' | 'question_answered', payload: unknown): void;
}

interface Pending {
  resolve: (answer: AgentQuestionAnswer) => void;
}

export class QuestionGate {
  /** questionId -> pending resolver. */
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly store: Store,
    private readonly emitter: GateEmitter,
  ) {}

  /**
   * Raise a question for a run and block until answered. Persists the question,
   * flips the run to `awaiting_input`, emits `ask_question`, and resolves with
   * the human's answer.
   */
  ask(runId: string, taskId: string, q: AgentQuestionRequest): Promise<AgentQuestionAnswer> {
    const question = this.store.createAgentQuestion({
      runId,
      taskId,
      header: q.header,
      question: q.question,
      options: q.options,
      multiSelect: q.multiSelect,
      permission: q.permission ?? null,
    });
    this.store.updateAgentRun(runId, { status: 'awaiting_input' });
    this.emitter.emit(runId, 'ask_question', this.publicShape(question));

    return new Promise<AgentQuestionAnswer>((resolve) => {
      this.pending.set(question.id, { resolve });
    });
  }

  /**
   * Record a human answer and resume the run. Returns the updated question, or
   * null if the question is unknown/already answered. Flips the run back to
   * `running` only once no unanswered questions remain for it.
   */
  answer(questionId: string, answer: AgentQuestionAnswer): AgentQuestion | null {
    const question = this.store.getAgentQuestion(questionId);
    if (!question || question.answer) return null;

    const recorded = this.store.recordAnswer(questionId, answer);
    this.emitter.emit(recorded.runId, 'question_answered', { questionId, answer });

    // Resume the run once nothing else is pending for it.
    if (this.store.listUnansweredForRun(recorded.runId).length === 0) {
      this.store.updateAgentRun(recorded.runId, { status: 'running' });
    }

    const p = this.pending.get(questionId);
    if (p) {
      this.pending.delete(questionId);
      p.resolve(answer);
    }
    return recorded;
  }

  /** Whether a question is still awaiting a (in-memory) resolver — for relay. */
  isPending(questionId: string): boolean {
    return this.pending.has(questionId);
  }

  /** The UI-facing shape of a question (no internal-only fields). */
  private publicShape(q: AgentQuestion) {
    return {
      id: q.id,
      runId: q.runId,
      header: q.header,
      question: q.question,
      options: q.options,
      multiSelect: q.multiSelect,
      permission: q.permission,
    };
  }
}
