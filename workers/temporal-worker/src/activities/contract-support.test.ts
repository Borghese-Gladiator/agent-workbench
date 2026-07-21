import { describe, expect, it } from 'vitest';
import { draftContract } from '@awb/planning';
import { draftContractInputFromPrompt } from './contract-support.js';

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
});
