export type FeedbackCategory =
  | 'question'
  | 'implementation-defect'
  | 'plan-defect'
  | 'contract-clarification'
  | 'non-blocking-suggestion'
  | 'out-of-scope';

/**
 * Classifies raw PR feedback text into one of the six categories from product spec §29. This is
 * a heuristic (keyword/pattern based) first pass suitable for automatically routing "clear
 * in-scope defects" to a repair loop; ambiguous or ambiguous-adjacent feedback should still
 * surface a human gate per spec §29 rather than trusting this classifier blindly for anything
 * high-stakes (scope expansion, contract conflicts, architectural decisions, dependency changes).
 */
export function classifyFeedback(body: string): FeedbackCategory {
  const text = body.toLowerCase().trim();

  // Specific-content signals are checked before the generic "is this a question" heuristic:
  // "Is this supposed to also handle X? Please clarify." is phrased as a question but is really
  // a contract clarification — a bare "why/how/does...?" with no other signal is the true
  // "question" case, so that check runs last among these.
  if (mentionsOutOfScope(text)) return 'out-of-scope';
  if (mentionsContractOrRequirements(text)) return 'contract-clarification';
  if (mentionsArchitectureOrPlan(text)) return 'plan-defect';
  if (mentionsBug(text)) return 'implementation-defect';
  if (isQuestion(text)) return 'question';
  if (isSuggestion(text)) return 'non-blocking-suggestion';

  return 'non-blocking-suggestion';
}

function isQuestion(text: string): boolean {
  if (text.endsWith('?')) return true;
  return /^(why|what|how|when|where|does|is|are|can|could|should)\b/.test(text);
}

function mentionsOutOfScope(text: string): boolean {
  return /(out of scope|not related to this|separate (pr|ticket|issue)|different (pr|ticket|issue))/.test(text);
}

function mentionsContractOrRequirements(text: string): boolean {
  return /(is this supposed to|should this actually|the requirement (is|was)|acceptance criteria|clarify|clarification)/.test(
    text,
  );
}

function mentionsArchitectureOrPlan(text: string): boolean {
  return /(architecture|design approach|should use a different (pattern|approach)|this design|wrong approach)/.test(
    text,
  );
}

function mentionsBug(text: string): boolean {
  return /(bug|broken|doesn'?t work|fails?|crash(es)?|error|incorrect|wrong result|null pointer|exception|regression)/.test(
    text,
  );
}

function isSuggestion(text: string): boolean {
  return /(nit:|nitpick|consider|might be nice|optional|minor|style|could also|suggest)/.test(text);
}

export interface FeedbackRoutingSignal {
  expandsScope: boolean;
  conflictsWithContract: boolean;
  requiresArchitecturalDecision: boolean;
  addsDependency: boolean;
  changesAcceptanceCriteria: boolean;
  isAmbiguous: boolean;
  conflictsWithOtherFeedback: boolean;
}

/** True when feedback should escalate to a human gate rather than auto-loop (product spec §29). */
export function feedbackRequiresHumanGate(signal: FeedbackRoutingSignal): boolean {
  return (
    signal.expandsScope ||
    signal.conflictsWithContract ||
    signal.requiresArchitecturalDecision ||
    signal.addsDependency ||
    signal.changesAcceptanceCriteria ||
    signal.isAmbiguous ||
    signal.conflictsWithOtherFeedback
  );
}

/** Only these categories are safe to auto-loop without a human gate, and only absent any routing signal. */
export function canAutoLoop(category: FeedbackCategory, signal: FeedbackRoutingSignal): boolean {
  if (feedbackRequiresHumanGate(signal)) return false;
  return category === 'implementation-defect';
}
