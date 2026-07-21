import type { DraftContractInput } from '@awb/planning';

/**
 * Builds a deterministic draft-contract input from the task's natural-language prompt (Fix 9,
 * option a): the objective is the prompt verbatim, plus two derived falsifiable claims — a
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
