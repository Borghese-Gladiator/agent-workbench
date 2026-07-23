import type { AgentEvent, Finding, ModelUsage } from '@awb/domain';

/** Which agent role a session is being created for — drives capability scoping upstream via @awb/capability-broker. */
export type AgentSessionRole =
  | 'planner'
  | 'plan-critic'
  | 'builder'
  | 'verifier'
  | 'qa-executor'
  | 'adversarial-reviewer';

export interface CreateAgentSessionInput {
  role: AgentSessionRole;
  taskId: string;
  /** The working directory the session is scoped to (a task worktree, or a read-only checkout view for read-only roles). */
  cwd: string;
  /** Free-form context payload assembled by the caller (contract, plan, repository facts, etc). Providers decide how to present it. */
  contextPayload: unknown;
  /** Allowed tool names for this session, derived from the capability broker for this role. */
  allowedTools: string[];
  /**
   * Tool names this session must be DENIED (the complement of `allowedTools` over the core tool
   * universe). Enforced by the adapter as the SDK's `disallowedTools` so a read-only role provably
   * cannot use them, even under `bypassPermissions` (TASK-24, §18/§33). Optional — the mock adapter
   * ignores it, and a caller that omits it gets no deny-list (allow-only, pre-TASK-24 behavior).
   */
  disallowedTools?: string[];
}

export interface AgentSession {
  id: string;
  role: AgentSessionRole;
  taskId: string;
  providerId: string;
  createdAt: string;
}

export interface AgentAssignment {
  /** The concrete instruction for this turn (a plan slice objective, a QA scenario, a review request, etc). */
  instruction: string;
  /** Stop conditions the provider should honor if it supports them (token/turn/time budgets). */
  stopConditions?: {
    maxTurns?: number;
    maxTokens?: number;
    maxWallClockMs?: number;
  };
}

export type AgentEventSink = (event: AgentEvent) => void;

export interface AgentExecutionResult {
  /** True if the session completed its turn normally (not aborted/timed out). */
  completed: boolean;
  /** Findings the session reported inline, if its role permits (e.g. plan-critic, reviewer). */
  findings: Finding[];
  /** Aggregate usage for this execution, if the provider reports it. */
  usage?: ModelUsage;
  /** A short human-readable summary of what happened, for semantic-event logging. */
  summary: string;
}

/**
 * Provider-neutral interface every coding-agent backend must implement (product spec §19).
 * Callers never depend on a specific provider's SDK/CLI shape directly — only on this interface.
 */
export interface CodingAgentAdapter {
  readonly id: string;

  createSession(input: CreateAgentSessionInput): Promise<AgentSession>;

  execute(
    session: AgentSession,
    assignment: AgentAssignment,
    eventSink: AgentEventSink,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult>;

  interrupt(session: AgentSession): Promise<void>;

  dispose(session: AgentSession): Promise<void>;
}
