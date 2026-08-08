import type { FindingCategory, TaskPhase } from '@awb/domain';

/**
 * Loop-routing table. Given the phase a "repair"/"replan" outcome originated
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

/**
 * `phaseSet` is the run's ordered phase list. It matters only for structural loop-backs:
 * a "the structure is wrong" finding (architecture / design-misunderstanding) routes to
 * `program-design` when the run HAS that phase (L tasks), otherwise to `plan`. Passing
 * `undefined` (or a set without `program-design`) routes to `plan`, so M/S runs and callers that
 * don't track the phase set are unaffected.
 */
export function routeLoop(trigger: LoopTrigger, phaseSet?: TaskPhase[]): TaskPhase {
  switch (trigger.kind) {
    case 'verify-failure':
      return 'implement';
    case 'exercise-behavior-defect':
      return 'implement';
    case 'exercise-design-misunderstanding':
      return structuralReviewPhase(phaseSet);
    case 'challenge-finding':
      return routeChallengeFinding(trigger.category, phaseSet);
    case 'release-conflict-requires-code-change':
      return 'implement';
    case 'release-candidate-sha-changed':
      return 'verify';
  }
}

/**
 * The phase that owns structural review for this run: `program-design` when the run walks it (L),
 * else `plan`. This is the single place the "route structure findings to the structure phase"
 * decision lives.
 */
function structuralReviewPhase(phaseSet: TaskPhase[] | undefined): TaskPhase {
  return phaseSet?.includes('program-design') ? 'program-design' : 'plan';
}

function routeChallengeFinding(category: FindingCategory, phaseSet: TaskPhase[] | undefined): TaskPhase {
  switch (category) {
    case 'architecture':
      return structuralReviewPhase(phaseSet);
    case 'requirements':
      return 'specify';
    default:
      return 'implement';
  }
}

/**
 * Escalation triggers that must produce a HumanGate rather than another loop iteration, even
 * though the phase itself hasn't reached a terminal outcome.
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
