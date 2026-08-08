import type { DraftContractInput } from '@awb/planning';
import type { TaskContract } from '@awb/domain';

/**
 * Builds a deterministic draft-contract input from the task's natural-language prompt: the
 * objective is the prompt verbatim, plus two derived falsifiable claims — a
 * correctness claim backed by deterministic evidence (the repo's tests must pass) and a behavioral
 * claim backed by QA evidence (the feature must be exercised). The behavioral claim's
 * `qaEvidenceRequired: true` is what makes the exercise phase demand real QA rather than skip it.
 *
 * This is the honest MVP substitute for an agent-authored specify session: it reflects the actual
 * request instead of a generic "implement task <id>" stub, without a live model call.
 */
export function draftContractInputFromPrompt(taskId: string, prompt: string): DraftContractInput {
  const objective = prompt.trim();
  return {
    taskId,
    objective,
    // The problem statement the human aligns on at the specify gate. Deterministic MVP
    // substitute for a live specify session.
    problemStatement: `The repository does not yet satisfy: ${objective}`,
    constraints: [],
    nonGoals: [],
    claims: [
      {
        description: `The requested change is implemented and its correctness is verified by the repository's passing tests: ${objective}`,
        category: 'correctness',
        deterministicEvidenceRequired: true,
        qaEvidenceRequired: false,
        humanJudgmentRequired: false,
      },
      {
        description: `The requested behavior is exercised end to end and captured as QA evidence: ${objective}`,
        category: 'behavior',
        deterministicEvidenceRequired: false,
        qaEvidenceRequired: true,
        humanJudgmentRequired: false,
      },
    ],
  };
}

/**
 * Renders the contract's problem statement + acceptance claims into the specify gate
 * summary, so the human reviewing the `task-contract-approval` gate aligns on them before any
 * planning spend — without a separate contract read route in the daemon/UI.
 */
export function formatContractGateSummary(contract: TaskContract): string {
  const claims =
    contract.claims.length > 0
      ? contract.claims.map((c) => `  - [${c.category}] ${c.description}`).join('\n')
      : '  (none)';
  return [
    `Contract v${contract.version} (size ${contract.size}) for task ${contract.taskId} awaits human approval.`,
    '',
    `Problem: ${contract.problemStatement}`,
    'Acceptance claims:',
    claims,
  ].join('\n');
}
