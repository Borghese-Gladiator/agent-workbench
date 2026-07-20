import type { FindingCategory, TaskPhase } from '@awb/domain';

/**
 * Loop-routing table (product spec §12). Given the phase a "repair"/"replan" outcome originated
 * from and, where relevant, the category of the finding that triggered it, determines which
 * phase the Workflow should route back to. Pure lookup — no I/O, no agent involvement.
 */
export type LoopTrigger =
  | { kind: 'verify-failure' }
  | { kind: 'exercise-behavior-defect' }
  | { kind: 'exercise-design-misunderstanding' }
  | { kind: 'challenge-finding'; category: FindingCategory }
  | { kind: 'release-conflict-requires-code-change' }
  | { kind: 'release-candidate-sha-changed' };

export function routeLoop(trigger: LoopTrigger): TaskPhase {
  switch (trigger.kind) {
    case 'verify-failure':
      return 'implement';
    case 'exercise-behavior-defect':
      return 'implement';
    case 'exercise-design-misunderstanding':
      return 'plan';
    case 'challenge-finding':
      return routeChallengeFinding(trigger.category);
    case 'release-conflict-requires-code-change':
      return 'implement';
    case 'release-candidate-sha-changed':
      return 'verify';
  }
}

function routeChallengeFinding(category: FindingCategory): TaskPhase {
  switch (category) {
    case 'architecture':
      return 'plan';
    case 'requirements':
      return 'specify';
    default:
      return 'implement';
  }
}

/**
 * Escalation triggers that must produce a HumanGate rather than another loop iteration, even
 * though the phase itself hasn't reached a terminal outcome (product spec §12, §14).
 */
export type EscalationTrigger =
  | { kind: 'repeated-identical-failure'; occurrences: number; threshold: number }
  | { kind: 'budget-exhaustion' };

export function shouldEscalateToHuman(trigger: EscalationTrigger): boolean {
  switch (trigger.kind) {
    case 'repeated-identical-failure':
      return trigger.occurrences >= trigger.threshold;
    case 'budget-exhaustion':
      return true;
  }
}
