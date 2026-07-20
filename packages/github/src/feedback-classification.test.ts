import { describe, expect, it } from 'vitest';
import { classifyFeedback, feedbackRequiresHumanGate, canAutoLoop, type FeedbackRoutingSignal } from './feedback-classification.js';

const noSignals: FeedbackRoutingSignal = {
  expandsScope: false,
  conflictsWithContract: false,
  requiresArchitecturalDecision: false,
  addsDependency: false,
  changesAcceptanceCriteria: false,
  isAmbiguous: false,
  conflictsWithOtherFeedback: false,
};

describe('classifyFeedback', () => {
  it('classifies a question', () => {
    expect(classifyFeedback('Why did you choose this approach?')).toBe('question');
    expect(classifyFeedback('does this handle the empty case')).toBe('question');
  });

  it('classifies an implementation defect', () => {
    expect(classifyFeedback('This throws a null pointer exception when the list is empty.')).toBe(
      'implementation-defect',
    );
    expect(classifyFeedback('The button is broken on mobile.')).toBe('implementation-defect');
  });

  it('classifies a plan defect', () => {
    expect(classifyFeedback('The architecture here is wrong, this should use a different pattern.')).toBe(
      'plan-defect',
    );
  });

  it('classifies a contract clarification', () => {
    expect(classifyFeedback('Is this supposed to also handle the admin role? Please clarify.')).toBe(
      'contract-clarification',
    );
  });

  it('classifies a non-blocking suggestion', () => {
    expect(classifyFeedback('nit: consider renaming this variable for clarity.')).toBe('non-blocking-suggestion');
  });

  it('classifies out-of-scope feedback', () => {
    expect(classifyFeedback('This is out of scope for this PR, please open a separate ticket.')).toBe(
      'out-of-scope',
    );
  });

  it('defaults ambiguous freeform feedback to a non-blocking suggestion rather than guessing a defect', () => {
    expect(classifyFeedback('Looks good overall.')).toBe('non-blocking-suggestion');
  });
});

describe('feedbackRequiresHumanGate', () => {
  it('does not require a gate when no signal fired', () => {
    expect(feedbackRequiresHumanGate(noSignals)).toBe(false);
  });

  it('requires a gate when scope expands', () => {
    expect(feedbackRequiresHumanGate({ ...noSignals, expandsScope: true })).toBe(true);
  });

  it('requires a gate when it conflicts with the contract', () => {
    expect(feedbackRequiresHumanGate({ ...noSignals, conflictsWithContract: true })).toBe(true);
  });

  it('requires a gate when it requires an architectural decision', () => {
    expect(feedbackRequiresHumanGate({ ...noSignals, requiresArchitecturalDecision: true })).toBe(true);
  });

  it('requires a gate when it adds a dependency', () => {
    expect(feedbackRequiresHumanGate({ ...noSignals, addsDependency: true })).toBe(true);
  });

  it('requires a gate when it changes acceptance criteria', () => {
    expect(feedbackRequiresHumanGate({ ...noSignals, changesAcceptanceCriteria: true })).toBe(true);
  });

  it('requires a gate when ambiguous', () => {
    expect(feedbackRequiresHumanGate({ ...noSignals, isAmbiguous: true })).toBe(true);
  });

  it('requires a gate when it conflicts with other feedback', () => {
    expect(feedbackRequiresHumanGate({ ...noSignals, conflictsWithOtherFeedback: true })).toBe(true);
  });
});

describe('canAutoLoop', () => {
  it('auto-loops a clear implementation defect with no routing signal', () => {
    expect(canAutoLoop('implementation-defect', noSignals)).toBe(true);
  });

  it('does not auto-loop a question even with no routing signal', () => {
    expect(canAutoLoop('question', noSignals)).toBe(false);
  });

  it('does not auto-loop an implementation defect if a routing signal fired', () => {
    expect(canAutoLoop('implementation-defect', { ...noSignals, expandsScope: true })).toBe(false);
  });

  it('does not auto-loop a plan defect', () => {
    expect(canAutoLoop('plan-defect', noSignals)).toBe(false);
  });
});
