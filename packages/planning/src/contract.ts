import { randomUUID } from 'node:crypto';
import type { AcceptanceClaim, TaskContract, TaskRisk } from '@awb/domain';

export interface DraftContractInput {
  taskId: string;
  objective: string;
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
  return {
    objectiveNonEmpty: contract.objective.trim().length > 0,
    claimCount: contract.claims.length,
    everyClaimHasEvidenceRequirements: contract.claims.every(
      (c) => c.deterministicEvidenceRequired || c.qaEvidenceRequired || c.humanJudgmentRequired,
    ),
    constraintsArrayPresent: Array.isArray(contract.constraints),
    nonGoalsArrayPresent: Array.isArray(contract.nonGoals),
    noUnresolvedAmbiguity,
    contractStatus: contract.status,
  };
}
