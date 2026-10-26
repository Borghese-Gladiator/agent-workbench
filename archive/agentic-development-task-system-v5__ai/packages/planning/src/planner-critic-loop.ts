import type { CodingAgentAdapter, AgentEventSink } from '@awb/agent-gateway';
import type { Finding, ImplementationPlan } from '@awb/domain';
import { createCapabilityBroker } from '@awb/capability-broker';

export interface PlannerCriticLoopInput {
  taskId: string;
  cwd: string;
  contextPayload: unknown;
  /** Produces a candidate plan given the accumulated critic findings from prior attempts (empty on the first attempt). */
  runPlanner: (priorFindings: Finding[]) => Promise<ImplementationPlan>;
  /** Produces critic findings for a candidate plan. Empty/no-blocker result means the plan is accepted. */
  runCritic: (plan: ImplementationPlan) => Promise<Finding[]>;
  maxAttempts?: number;
}

export type PlannerCriticLoopResult =
  | { outcome: 'accepted'; plan: ImplementationPlan; attempts: number }
  | { outcome: 'non-convergent'; lastPlan: ImplementationPlan; lastFindings: Finding[]; attempts: number };

function hasBlockerOrHigh(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'blocker' || f.severity === 'high');
}

/**
 * Runs the bounded planner <-> plan-critic loop (product spec §20): the planner is always a
 * fresh read-only session, the critic is always a separate fresh read-only session. If the
 * critic returns a blocker/high-severity finding, the planner gets another attempt informed by
 * those findings. After `maxAttempts` without convergence, returns "non-convergent" so the
 * caller can raise a `planner-critic-non-convergence` human gate rather than looping forever.
 */
export async function runPlannerCriticLoop(input: PlannerCriticLoopInput): Promise<PlannerCriticLoopResult> {
  const maxAttempts = input.maxAttempts ?? 3;
  let findings: Finding[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const plan = await input.runPlanner(findings);
    const criticFindings = await input.runCritic(plan);

    if (!hasBlockerOrHigh(criticFindings)) {
      return { outcome: 'accepted', plan, attempts: attempt };
    }

    findings = criticFindings;
    if (attempt === maxAttempts) {
      return { outcome: 'non-convergent', lastPlan: plan, lastFindings: criticFindings, attempts: attempt };
    }
  }

  // Unreachable given maxAttempts >= 1, but keeps the return type total.
  throw new Error('runPlannerCriticLoop: maxAttempts must be at least 1');
}

export interface AgentSessionRunner {
  adapter: CodingAgentAdapter;
  taskId: string;
  cwd: string;
  contextPayload: unknown;
}

/** Capability-scoped tool list for a role, derived from @awb/capability-broker, ready to pass into CreateAgentSessionInput. */
export function allowedToolsForRole(role: 'planner' | 'plan-critic'): string[] {
  return [...createCapabilityBroker(role).listGranted()];
}

export const NOOP_EVENT_SINK: AgentEventSink = () => {};
