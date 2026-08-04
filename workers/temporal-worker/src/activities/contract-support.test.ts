import { describe, expect, it } from 'vitest';
import { contractCompletionInputs, draftContract } from '@awb/planning';
import { draftContractInputFromPrompt, formatContractGateSummary } from './contract-support.js';

describe('draftContractInputFromPrompt (Fix 9: real contract from prompt)', () => {
  const prompt = 'Implement the President card game as a new game in this repo';

  it('uses the prompt verbatim as the objective', () => {
    const input = draftContractInputFromPrompt('task-1', prompt);
    expect(input.objective).toBe(prompt);
    expect(input.taskId).toBe('task-1');
  });

  it('derives a deterministic correctness claim and a QA-required behavioral claim', () => {
    const input = draftContractInputFromPrompt('task-1', prompt);
    expect(input.claims).toHaveLength(2);

    const correctness = input.claims.find((c) => c.category === 'correctness');
    const behavior = input.claims.find((c) => c.category === 'behavior');
    expect(correctness?.deterministicEvidenceRequired).toBe(true);
    expect(behavior?.qaEvidenceRequired).toBe(true);
  });

  it('produces a valid TaskContract when passed to draftContract', () => {
    const contract = draftContract(draftContractInputFromPrompt('task-1', prompt));
    expect(contract.objective).toContain('President');
    expect(contract.claims.some((c) => c.qaEvidenceRequired)).toBe(true);
    expect(contract.version).toBe(1);
  });

  // TASK-54: the prompt-derived contract clears the specify gate's problem/success-criteria checks.
  it('supplies a problem statement and a measurable success criterion for its behavioral claim', () => {
    const contract = draftContract(draftContractInputFromPrompt('task-1', prompt));
    const inputs = contractCompletionInputs(contract, true);
    expect(inputs.problemStatementPresent).toBe(true);
    expect(inputs.successCriteriaPresentForBehavioralClaims).toBe(true);
  });

  it('renders the problem statement and success criteria into the gate summary', () => {
    const contract = draftContract(draftContractInputFromPrompt('task-1', prompt));
    const summary = formatContractGateSummary(contract);
    expect(summary).toContain('Problem:');
    expect(summary).toContain('Success criteria:');
    expect(summary).toContain(contract.successCriteria[0]!.description);
  });
});
