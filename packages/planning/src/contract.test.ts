import { describe, expect, it } from 'vitest';
import {
  draftContract,
  reviseContract,
  markAwaitingApproval,
  approveContract,
  rejectContract,
  supersedeContract,
  contractCompletionInputs,
} from './contract.js';

const baseClaim = {
  description: 'Feature works end to end',
  category: 'behavior' as const,
  deterministicEvidenceRequired: true,
  qaEvidenceRequired: true,
  humanJudgmentRequired: false,
};

describe('draftContract', () => {
  it('creates a version-1 draft with defaults for optional fields', () => {
    const contract = draftContract({ taskId: 'task-1', objective: 'Add dark mode', claims: [baseClaim] });
    expect(contract.version).toBe(1);
    expect(contract.status).toBe('draft');
    expect(contract.constraints).toEqual([]);
    expect(contract.nonGoals).toEqual([]);
    expect(contract.risk).toBe('low');
    expect(contract.claims).toHaveLength(1);
    expect(contract.claims[0]?.id).toBeTruthy();
  });

  it('assigns each claim a unique id', () => {
    const contract = draftContract({ taskId: 'task-1', objective: 'x', claims: [baseClaim, baseClaim] });
    const ids = contract.claims.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
  });

  // TASK-54: problem statement + measurable success criteria.
  it('defaults the problem statement to the objective and success criteria to empty', () => {
    const contract = draftContract({ taskId: 'task-1', objective: 'Add dark mode', claims: [baseClaim] });
    expect(contract.problemStatement).toBe('Add dark mode');
    expect(contract.successCriteria).toEqual([]);
  });

  it('populates and ids the supplied success criteria', () => {
    const contract = draftContract({
      taskId: 'task-1',
      objective: 'Add dark mode',
      problemStatement: 'no dark mode exists',
      successCriteria: [{ description: 'toggling switches theme', measurable: true }],
      claims: [baseClaim],
    });
    expect(contract.problemStatement).toBe('no dark mode exists');
    expect(contract.successCriteria).toHaveLength(1);
    expect(contract.successCriteria[0]?.id).toBeTruthy();
    expect(contract.successCriteria[0]?.measurable).toBe(true);
  });
});

describe('reviseContract', () => {
  it('increments the version and carries the taskId forward', () => {
    const first = draftContract({ taskId: 'task-1', objective: 'v1', claims: [baseClaim] });
    const revised = reviseContract(first, { taskId: 'task-1', objective: 'v2', claims: [baseClaim] });
    expect(revised.version).toBe(2);
    expect(revised.taskId).toBe('task-1');
    expect(revised.objective).toBe('v2');
  });
});

describe('contract status transitions', () => {
  it('moves draft -> awaiting_approval -> approved', () => {
    const contract = draftContract({ taskId: 'task-1', objective: 'x', claims: [baseClaim] });
    const awaiting = markAwaitingApproval(contract);
    expect(awaiting.status).toBe('awaiting_approval');
    const approved = approveContract(awaiting);
    expect(approved.status).toBe('approved');
  });

  it('moves draft -> awaiting_approval -> rejected', () => {
    const contract = draftContract({ taskId: 'task-1', objective: 'x', claims: [baseClaim] });
    const rejected = rejectContract(markAwaitingApproval(contract));
    expect(rejected.status).toBe('rejected');
  });

  it('marks a contract superseded', () => {
    const contract = draftContract({ taskId: 'task-1', objective: 'x', claims: [baseClaim] });
    expect(supersedeContract(contract).status).toBe('superseded');
  });
});

describe('contractCompletionInputs', () => {
  it('reports complete-ready inputs for a well-formed approved contract', () => {
    const contract = approveContract(
      markAwaitingApproval(draftContract({ taskId: 'task-1', objective: 'Add dark mode', claims: [baseClaim] })),
    );
    const inputs = contractCompletionInputs(contract, true);
    expect(inputs.objectiveNonEmpty).toBe(true);
    expect(inputs.claimCount).toBe(1);
    expect(inputs.everyClaimHasEvidenceRequirements).toBe(true);
    expect(inputs.contractStatus).toBe('approved');
  });

  it('flags a claim with no evidence requirements at all', () => {
    const contract = draftContract({
      taskId: 'task-1',
      objective: 'x',
      claims: [
        {
          description: 'no evidence needed?',
          category: 'behavior',
          deterministicEvidenceRequired: false,
          qaEvidenceRequired: false,
          humanJudgmentRequired: false,
        },
      ],
    });
    expect(contractCompletionInputs(contract, true).everyClaimHasEvidenceRequirements).toBe(false);
  });

  it('flags an empty objective', () => {
    const contract = draftContract({ taskId: 'task-1', objective: '   ', claims: [baseClaim] });
    expect(contractCompletionInputs(contract, true).objectiveNonEmpty).toBe(false);
  });

  // TASK-54: reviewer-alignment before implementation.
  it('requires a measurable success criterion when a behavioral claim is present', () => {
    const withBehavioral = draftContract({ taskId: 'task-1', objective: 'Add dark mode', claims: [baseClaim] });
    expect(
      contractCompletionInputs(withBehavioral, true).successCriteriaPresentForBehavioralClaims,
    ).toBe(false);

    const satisfied = draftContract({
      taskId: 'task-1',
      objective: 'Add dark mode',
      successCriteria: [{ description: 'theme toggles', measurable: true }],
      claims: [baseClaim],
    });
    expect(contractCompletionInputs(satisfied, true).successCriteriaPresentForBehavioralClaims).toBe(true);
  });

  it('does not require success criteria for a non-behavioral contract', () => {
    const nonBehavioral = draftContract({
      taskId: 'task-1',
      objective: 'Refactor internals',
      claims: [
        {
          description: 'internals refactored',
          category: 'correctness',
          deterministicEvidenceRequired: true,
          qaEvidenceRequired: false,
          humanJudgmentRequired: false,
        },
      ],
    });
    const inputs = contractCompletionInputs(nonBehavioral, true);
    expect(inputs.successCriteriaPresentForBehavioralClaims).toBe(true);
    expect(inputs.problemStatementPresent).toBe(true);
  });
});
