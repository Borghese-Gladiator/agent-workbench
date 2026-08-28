import {
  proxyActivities,
  setHandler,
  condition,
  defineSignal,
  defineUpdate,
  defineQuery,
  ApplicationFailure,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import type { TaskPhase, TaskSize, HumanGateReason, PhaseAttemptResult } from '@awb/domain';
import { nextPhaseIn, phaseSetForSize } from './phase-order.js';
import type { TaskWorkflowInput, TaskWorkflowState } from './workflow-types.js';
import { shouldEscalateToHuman } from './loop-routing.js';

export interface TaskActivities {
  runPhase(input: { phase: TaskPhase; state: TaskWorkflowState }): Promise<PhaseAttemptResult>;
}

const activities = proxyActivities<TaskActivities>({
  startToCloseTimeout: '30 minutes',
  // A phase that stops making progress (e.g. a hung verify command) must be detected by liveness, not
  // by the coarse 30-minute startToClose. runPhase heartbeats while it works (per verify command); if
  // heartbeats stop for this long, Temporal times the attempt out and it retries — surfacing a stuck
  // phase in minutes instead of blocking half an hour, and letting the workflow count it (below).
  heartbeatTimeout: '2 minutes',
  retry: {
    // Deterministic engineering failures are never Activity exceptions — only
    // transient infrastructure failures (provider timeout, GitHub blip, process crash, fs
    // hiccup, upload interruption) retry here.
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

// Updates — synchronous, validated against current state before applying.
export const approveContractUpdate = defineUpdate<void, [{ contractVersion: number; size?: TaskSize }]>(
  'approveContract',
);
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

/**
 * History-length threshold for continue-as-new. A long task — especially one that loops
 * many times through repair/replan, or waits a long time on PR feedback — grows Temporal workflow
 * history unbounded. Past this many events we continue-as-new: re-seed a fresh execution from the
 * current coordination state so history resets while the task proceeds seamlessly.
 */
const CONTINUE_AS_NEW_HISTORY_THRESHOLD = 10_000;

function initialState(input: TaskWorkflowInput): TaskWorkflowState {
  // A continue-as-new re-seed carries the full prior state; the initial start builds a fresh one.
  if (input.resumeState) return input.resumeState;
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
    // An intake size hint (CLI --size) seeds the classifier's prior; the classifier/gate can still
    // change it. phaseSet stays undefined until specify completes and derives it.
    size: input.size,
    // Stacked-PR base override (TASK-72); prepare/release read it off the coordination state.
    baseBranch: input.baseBranch,
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

  setHandler(approveContractUpdate, (args) => {
    if (state.phase !== 'specify' || state.pendingHumanGate?.reason !== 'task-contract-approval') {
      throw ApplicationFailure.nonRetryable('No pending contract approval gate for this task');
    }
    // A human may override the classifier's size at the gate. When they do, it wins over
    // whatever specify's candidate later reports: pin the size + derived phase set and mark them human-set.
    const override = args?.size;
    state = {
      ...state,
      condition: 'running',
      pendingHumanGate: undefined,
      ...(override ? { size: override, phaseSet: phaseSetForSize(override), sizeHumanOverridden: true } : {}),
    };
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

    // Continue-as-new before history grows unbounded. Do this at the top of the loop —
    // never mid-phase — and only while running with no pending gate, so the re-seeded execution
    // starts from a clean, resumable coordination state. `state` carries everything the next run needs.
    if (
      state.condition === 'running' &&
      !state.pendingHumanGate &&
      workflowInfo().historyLength >= CONTINUE_AS_NEW_HISTORY_THRESHOLD
    ) {
      await continueAsNew<typeof TaskWorkflow>({
        taskId: state.taskId,
        repositoryId: state.repositoryId,
        prompt: state.prompt,
        resumeState: state,
      });
    }

    state = { ...state, attemptNumber: state.attemptNumber + 1 };
    const phaseThatRan = state.phase;
    let result: PhaseAttemptResult;
    try {
      result = await activities.runPhase({ phase: state.phase, state });
    } catch {
      // The Activity exhausted its retries — a genuinely stuck phase (e.g. a hung verify command that
      // stopped heartbeating and tripped heartbeatTimeout, retried, and failed again). Temporal would
      // otherwise fail the whole Workflow (or silently replay). Fold it into the SAME no-progress
      // accounting a repaired failure uses: a `repair` outcome so the failure streak for this phase
      // advances and a genuinely stuck phase surfaces as a counted `repeated-failure-no-progress` gate
      // instead of a silent "attempt 1" replay or a workflow crash.
      result = { outcome: 'repair', target: 'implement', findings: [] };
    }

    // Accumulate the agent usage this attempt reported before routing mutates state.phase.
    // Tokens sum across the whole task; runtime accumulates per phase across its attempts/loop-backs.
    if (result.usage) {
      state = {
        ...state,
        tokenUsageTotal: {
          inputTokens: state.tokenUsageTotal.inputTokens + result.usage.inputTokens,
          outputTokens: state.tokenUsageTotal.outputTokens + result.usage.outputTokens,
        },
        runtimeMsByPhase: {
          ...state.runtimeMsByPhase,
          [phaseThatRan]: (state.runtimeMsByPhase[phaseThatRan] ?? 0) + result.usage.runtimeMs,
        },
      };
    }

    switch (result.outcome) {
      case 'candidate': {
        state = {
          ...state,
          latestCandidateEvidenceIds: result.candidate.evidenceIds,
          openFindingIds: result.candidate.openFindingIds,
        };
        // The specify candidate reports the classified size. Adopt it to derive the run's
        // phase set — UNLESS a human already overrode it at the contract gate, which wins.
        if (phaseThatRan === 'specify' && result.size && !state.sizeHumanOverridden) {
          state = { ...state, size: result.size, phaseSet: phaseSetForSize(result.size) };
        }
        failureStreak.delete(state.phase);
        state = { ...state, phase: nextPhase(state.phase, state.phaseSet), attemptNumber: 0 };
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

function nextPhase(phase: TaskPhase, phaseSet: TaskPhase[] | undefined): TaskPhase {
  return nextPhaseIn(phaseSet, phase);
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
