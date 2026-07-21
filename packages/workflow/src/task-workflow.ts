import {
  proxyActivities,
  setHandler,
  condition,
  defineSignal,
  defineUpdate,
  defineQuery,
  ApplicationFailure,
} from '@temporalio/workflow';
import type { TaskPhase, HumanGateReason, PhaseAttemptResult } from '@awb/domain';
import { TASK_PHASE_ORDER } from './phase-order.js';
import type { TaskWorkflowInput, TaskWorkflowState } from './workflow-types.js';
import { shouldEscalateToHuman } from './loop-routing.js';

export interface TaskActivities {
  runPhase(input: { phase: TaskPhase; state: TaskWorkflowState }): Promise<PhaseAttemptResult>;
}

const activities = proxyActivities<TaskActivities>({
  startToCloseTimeout: '30 minutes',
  retry: {
    // Deterministic engineering failures are never Activity exceptions (spec §12) — only
    // transient infrastructure failures (provider timeout, GitHub blip, process crash, fs
    // hiccup, upload interruption) retry here.
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

// Updates — synchronous, validated against current state before applying.
export const approveContractUpdate = defineUpdate<void, [{ contractVersion: number }]>('approveContract');
export const rejectContractUpdate = defineUpdate<void, [{ reason: string }]>('rejectContract');
export const approvePlanUpdate = defineUpdate<void, [{ planVersion: number }]>('approvePlan');
export const rejectPlanUpdate = defineUpdate<void, [{ reason: string }]>('rejectPlan');
export const approveWaiverUpdate = defineUpdate<void, [{ waiverId: string }]>('approveWaiver');
export const approvePermissionUpdate = defineUpdate<void, [{ permission: string }]>('approvePermission');
export const extendBudgetUpdate = defineUpdate<void, [{ additionalTokens?: number; additionalMinutes?: number }]>(
  'extendBudget',
);
export const approveScopeChangeUpdate = defineUpdate<void, [{ description: string }]>('approveScopeChange');

// Signals — asynchronous, fire-and-forget from the caller's perspective.
export const cancelSignal = defineSignal('cancel');
export const pauseSignal = defineSignal('pause');
export const resumeSignal = defineSignal('resume');
export const pullRequestFeedbackReceivedSignal = defineSignal<[{ feedbackId: string }]>(
  'pullRequestFeedbackReceived',
);
export const pullRequestMergedSignal = defineSignal<[{ mergeCommitSha: string }]>('pullRequestMerged');
export const pullRequestClosedSignal = defineSignal('pullRequestClosed');
export const externalBranchChangedSignal = defineSignal<[{ newTargetSha: string }]>('externalBranchChanged');

// Queries — read-only, side-effect-free, fast.
export const getCurrentStateQuery = defineQuery<TaskWorkflowState>('getCurrentState');
export const getCurrentActionQuery = defineQuery<string>('getCurrentAction');
export const getCompletionStatusQuery = defineQuery<{ phase: TaskPhase; attemptNumber: number }>(
  'getCompletionStatus',
);
export const getOpenFindingsQuery = defineQuery<string[]>('getOpenFindings');
export const getEvidenceStatusQuery = defineQuery<string[]>('getEvidenceStatus');
export const getRuntimeBreakdownQuery = defineQuery<TaskWorkflowState['runtimeMsByPhase']>('getRuntimeBreakdown');
export const getTokenBreakdownQuery = defineQuery<TaskWorkflowState['tokenUsageTotal']>('getTokenBreakdown');
export const getPendingHumanGateQuery = defineQuery<TaskWorkflowState['pendingHumanGate']>('getPendingHumanGate');

const NO_PROGRESS_THRESHOLD = 3;

function initialState(input: TaskWorkflowInput): TaskWorkflowState {
  return {
    taskId: input.taskId,
    repositoryId: input.repositoryId,
    prompt: input.prompt,
    phase: 'specify',
    condition: 'running',
    deliveryState: 'not-started',
    attemptNumber: 0,
    latestCandidateEvidenceIds: [],
    openFindingIds: [],
    tokenUsageTotal: { inputTokens: 0, outputTokens: 0 },
    runtimeMsByPhase: {},
  };
}

function humanGateReasonForPhase(phase: TaskPhase): HumanGateReason {
  if (phase === 'specify') return 'task-contract-approval';
  if (phase === 'release') return 'pr-readiness';
  return 'repeated-failure-no-progress';
}

/**
 * TaskWorkflow — one execution per task, workflow ID `awb/task/{repositoryId}/{taskId}`.
 * Deterministic: all filesystem/git/process/agent/network access happens inside `runPhase`
 * Activities, never here. This function only interprets typed PhaseAttemptResults and decides
 * phase transitions — it never lets an agent decide completion itself.
 */
export async function TaskWorkflow(input: TaskWorkflowInput): Promise<TaskWorkflowState> {
  let state = initialState(input);
  let cancelled = false;
  let paused = false;
  const failureStreak = new Map<TaskPhase, number>();

  setHandler(cancelSignal, () => {
    cancelled = true;
    state = { ...state, condition: 'cancelled' };
  });
  setHandler(pauseSignal, () => {
    paused = true;
  });
  setHandler(resumeSignal, () => {
    paused = false;
  });

  setHandler(approveContractUpdate, (_args) => {
    if (state.phase !== 'specify' || state.pendingHumanGate?.reason !== 'task-contract-approval') {
      throw ApplicationFailure.nonRetryable('No pending contract approval gate for this task');
    }
    state = { ...state, condition: 'running', pendingHumanGate: undefined };
  });
  setHandler(rejectContractUpdate, () => {
    state = { ...state, condition: 'running', pendingHumanGate: undefined };
  });
  setHandler(approvePlanUpdate, () => {
    state = { ...state, condition: 'running', pendingHumanGate: undefined };
  });
  setHandler(rejectPlanUpdate, () => {
    state = { ...state, condition: 'running', pendingHumanGate: undefined };
  });
  setHandler(approveWaiverUpdate, () => {
    state = { ...state, condition: 'running', pendingHumanGate: undefined };
  });
  setHandler(approvePermissionUpdate, () => {
    state = { ...state, condition: 'running', pendingHumanGate: undefined };
  });
  setHandler(extendBudgetUpdate, () => {
    state = { ...state, condition: 'running', pendingHumanGate: undefined };
    failureStreak.clear();
  });
  setHandler(approveScopeChangeUpdate, () => {
    state = { ...state, condition: 'running', pendingHumanGate: undefined };
  });

  setHandler(pullRequestFeedbackReceivedSignal, () => {
    state = { ...state, deliveryState: 'awaiting-review' };
  });
  setHandler(pullRequestMergedSignal, () => {
    state = { ...state, deliveryState: 'merged', phase: 'assimilate', condition: 'running' };
  });
  setHandler(pullRequestClosedSignal, () => {
    state = { ...state, deliveryState: 'closed', phase: 'assimilate', condition: 'running' };
  });
  setHandler(externalBranchChangedSignal, () => {
    // Reconciliation on the next Release attempt is responsible for deciding whether this
    // actually changes the candidate SHA; here we only note that Release's evidence may be stale.
  });

  setHandler(getCurrentStateQuery, () => state);
  setHandler(getCurrentActionQuery, () => `${state.phase} (attempt ${state.attemptNumber}, ${state.condition})`);
  setHandler(getCompletionStatusQuery, () => ({ phase: state.phase, attemptNumber: state.attemptNumber }));
  setHandler(getOpenFindingsQuery, () => state.openFindingIds);
  setHandler(getEvidenceStatusQuery, () => state.latestCandidateEvidenceIds);
  setHandler(getRuntimeBreakdownQuery, () => state.runtimeMsByPhase);
  setHandler(getTokenBreakdownQuery, () => state.tokenUsageTotal);
  setHandler(getPendingHumanGateQuery, () => state.pendingHumanGate);

  while (!cancelled && state.phase !== 'assimilate') {
    await condition(() => !paused || cancelled);
    if (cancelled) break;

    if (state.condition === 'awaiting-human' || state.condition === 'blocked') {
      await condition(() => state.condition === 'running' || cancelled);
      if (cancelled) break;
    }

    state = { ...state, attemptNumber: state.attemptNumber + 1 };
    const result = await activities.runPhase({ phase: state.phase, state });

    switch (result.outcome) {
      case 'candidate': {
        state = {
          ...state,
          latestCandidateEvidenceIds: result.candidate.evidenceIds,
          openFindingIds: result.candidate.openFindingIds,
        };
        failureStreak.delete(state.phase);
        state = { ...state, phase: nextPhase(state.phase), attemptNumber: 0 };
        break;
      }
      case 'repair': {
        const streak = (failureStreak.get(state.phase) ?? 0) + 1;
        failureStreak.set(state.phase, streak);
        if (shouldEscalateToHuman({ kind: 'repeated-identical-failure', occurrences: streak, threshold: NO_PROGRESS_THRESHOLD })) {
          state = {
            ...state,
            condition: 'awaiting-human',
            pendingHumanGate: makeGate(state.taskId, state.phase, 'repeated-failure-no-progress'),
          };
        } else {
          // PhaseAttemptResult's "repair" outcome always targets "implement" (see @awb/domain) —
          // routeLoop's per-finding-category table applies to "replan"/"challenge", not here.
          state = { ...state, phase: result.target, attemptNumber: 0 };
        }
        break;
      }
      case 'replan': {
        state = { ...state, phase: result.target, attemptNumber: 0 };
        break;
      }
      case 'await-human': {
        state = { ...state, condition: 'awaiting-human', pendingHumanGate: result.gate };
        break;
      }
      case 'blocked': {
        state = {
          ...state,
          condition: 'blocked',
          pendingHumanGate: makeGate(state.taskId, state.phase, humanGateReasonForPhase(state.phase)),
        };
        break;
      }
      case 'cancelled': {
        cancelled = true;
        state = { ...state, condition: 'cancelled' };
        break;
      }
    }
  }

  if (state.phase === 'assimilate' && state.condition !== 'cancelled') {
    state = { ...state, condition: 'completed' };
  }

  return state;
}

function nextPhase(phase: TaskPhase): TaskPhase {
  const idx = TASK_PHASE_ORDER.indexOf(phase);
  const next = TASK_PHASE_ORDER[idx + 1];
  return next ?? 'assimilate';
}

function makeGate(taskId: string, phase: TaskPhase, reason: HumanGateReason) {
  // `Date` inside Workflow code is patched by the Temporal SDK to be deterministic/replay-safe,
  // so using it directly here (rather than an Activity) is correct.
  return {
    id: `${taskId}-${phase}-gate`,
    taskId,
    phase,
    reason,
    summary: `Task ${taskId} needs human input at phase ${phase} (${reason})`,
    createdAt: new Date().toISOString(),
  };
}
