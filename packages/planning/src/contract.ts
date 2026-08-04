import { randomUUID } from 'node:crypto';
import type { AcceptanceClaim, SuccessCriterion, TaskContract, TaskRisk } from '@awb/domain';

export interface DraftContractInput {
  taskId: string;
  objective: string;
  /**
   * TASK-54: the problem the task solves, aligned on with the human before any planning
   * spend. Defaults to the objective when the drafting agent supplies nothing.
   */
  problemStatement?: string;
  /**
   * TASK-54: measurable success criteria the human approves at the specify gate. These
   * become the reference the QA rubric is held to (a behavioral claim's criteria feed the
   * expected per-claim assertions in TASK-42).
   */
  successCriteria?: Omit<SuccessCriterion, 'id'>[];
  constraints?: string[];
  nonGoals?: string[];
  risk?: TaskRisk;
  claims: Omit<AcceptanceClaim, 'id'>[];
}

/**
 * Constructs a new draft TaskContract. This does not itself talk to an agent — the caller
 * (a Specify-phase Activity) is responsible for turning a raw task prompt into `DraftContractInput`
 * via a planner-role agent session, then handing the result here to produce a well-formed,
 * versioned TaskContract row ready for human approval.
 */
export function draftContract(input: DraftContractInput, version = 1): TaskContract {
  return {
    id: randomUUID(),
    taskId: input.taskId,
    version,
    objective: input.objective,
    problemStatement: input.problemStatement ?? input.objective,
    successCriteria: (input.successCriteria ?? []).map((c) => ({ ...c, id: randomUUID() })),
    constraints: input.constraints ?? [],
    nonGoals: input.nonGoals ?? [],
    risk: input.risk ?? 'low',
    claims: input.claims.map((claim) => ({ ...claim, id: randomUUID() })),
    status: 'draft',
  };
}

/** Produces the next contract version after a rejection or a required scope change, carrying forward the taskId. */
export function reviseContract(previous: TaskContract, input: DraftContractInput): TaskContract {
  return draftContract(input, previous.version + 1);
}

export function markAwaitingApproval(contract: TaskContract): TaskContract {
  return { ...contract, status: 'awaiting_approval' };
}

export function approveContract(contract: TaskContract): TaskContract {
  return { ...contract, status: 'approved' };
}

export function rejectContract(contract: TaskContract): TaskContract {
  return { ...contract, status: 'rejected' };
}

export function supersedeContract(contract: TaskContract): TaskContract {
  return { ...contract, status: 'superseded' };
}

/**
 * Specify-phase completion checklist (product spec §11), expressed as a pure function over a
 * TaskContract so it can feed `@awb/workflow`'s CompletionContext.specify shape directly.
 */
export function contractCompletionInputs(contract: TaskContract, noUnresolvedAmbiguity: boolean) {
  const hasBehavioralClaim = contract.claims.some(
    (c) => c.category === 'behavior' && c.qaEvidenceRequired,
  );
  return {
    objectiveNonEmpty: contract.objective.trim().length > 0,
    claimCount: contract.claims.length,
    everyClaimHasEvidenceRequirements: contract.claims.every(
      (c) => c.deterministicEvidenceRequired || c.qaEvidenceRequired || c.humanJudgmentRequired,
    ),
    constraintsArrayPresent: Array.isArray(contract.constraints),
    nonGoalsArrayPresent: Array.isArray(contract.nonGoals),
    noUnresolvedAmbiguity,
    // TASK-54: reviewer-alignment before implementation. The problem statement is always
    // required; measurable success criteria are mandatory only when the task carries a
    // behavioral claim (mirrors everyBehavioralClaimHasQaScenario, so non-behavioral / mock
    // tasks are unaffected).
    problemStatementPresent: contract.problemStatement.trim().length > 0,
    successCriteriaPresentForBehavioralClaims:
      !hasBehavioralClaim || contract.successCriteria.some((c) => c.measurable),
    contractStatus: contract.status,
  };
}
