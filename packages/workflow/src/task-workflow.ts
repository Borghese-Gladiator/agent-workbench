import {
  proxyActivities,
  setHandler,
  condition,
  defineSignal,
  defineUpdate,
  defineQuery,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import type { TaskPhase, TaskSize, LoopBudget, PhaseAttemptResult } from '@awb/domain';
import { nextPhaseIn, phaseSetForSize } from './phase-order.js';
import type { TaskWorkflowInput, TaskWorkflowState } from './workflow-types.js';
import { evaluateLoopBudget, buildUnmetCriteria } from './loop-budget.js';
import { initialNoProgressState, recordAttempt } from './no-progress.js';

export interface TaskActivities {
  runPhase(input: { phase: TaskPhase; state: TaskWorkflowState }): Promise<PhaseAttemptResult>;
}

const activities = proxyActivities<TaskActivities>({
  startToCloseTimeout: '30 minutes',
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
export const getUnmetCriteriaQuery = defineQuery<TaskWorkflowState['unmetCriteria']>('getUnmetCriteria');

const NO_PROGRESS_THRESHOLD = 3;

/**
 * Default bounded-autonomy budget (TASK-105) when the task does not supply its own. Deliberately
 * generous — it is a backstop against a runaway loop, not a routine constraint. Exhausting any
 * dimension terminates the task with a `budget-exhausted` UnmetCriteria and a draft PR, never a
 * human escalation.
 */
const DEFAULT_LOOP_BUDGET: LoopBudget = {
  maxPhaseAttempts: 25,
  maxTotalTokens: 20_000_000,
  maxWallClockMs: 6 * 60 * 60 * 1000,
};

/**
 * A cheap deterministic per-phase failure fingerprint for the no-progress tracker. The workflow has
 * no access to real command output (that lives in the Activity), so it folds the phase + attempt's
 * finding ids — a repair that keeps producing the SAME open findings on the SAME phase is the
 * edit/revert loop `isNoProgress` is meant to catch.
 */
function repairFingerprint(phase: TaskPhase, findingIds: string[]): string {
  return `${phase}::${[...findingIds].sort().join(',')}`;
}

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
    // Bounded-autonomy backstop (TASK-105): exhaustion ends the task at a draft PR, not a human gate.
    loopBudget: input.loopBudget ?? DEFAULT_LOOP_BUDGET,
    noProgress: initialNoProgressState(),
  };
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

  // Autonomy pivot (TASK-104): the loop no longer PARKS on any of these, so they are no longer
  // gate-resolution handshakes. `approveContract` is retained only as an optional size-override
  // channel (a caller may still pin the task size); the rest are retained as no-op acknowledgements
  // so existing callers/signals don't fail, but none of them unblock a wait state — there is none.
  setHandler(approveContractUpdate, (args) => {
    const override = args?.size;
    if (override) {
      state = { ...state, size: override, phaseSet: phaseSetForSize(override), sizeHumanOverridden: true };
    }
  });
  setHandler(rejectContractUpdate, () => {});
  setHandler(approvePlanUpdate, () => {});
  setHandler(rejectPlanUpdate, () => {});
  setHandler(approveWaiverUpdate, () => {});
  setHandler(approvePermissionUpdate, () => {});
  setHandler(extendBudgetUpdate, (args) => {
    // Budget is now a hard autonomy backstop, not a human handshake, but a caller may still widen it.
    if (state.loopBudget && (args?.additionalTokens || args?.additionalMinutes)) {
      state = {
        ...state,
        loopBudget: {
          ...state.loopBudget,
          maxTotalTokens: state.loopBudget.maxTotalTokens + (args.additionalTokens ?? 0),
          maxWallClockMs: state.loopBudget.maxWallClockMs + (args.additionalMinutes ?? 0) * 60_000,
        },
      };
    }
  });
  setHandler(approveScopeChangeUpdate, () => {});

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
  setHandler(getUnmetCriteriaQuery, () => state.unmetCriteria);

  while (!cancelled && state.phase !== 'assimilate') {
    await condition(() => !paused || cancelled);
    if (cancelled) break;

    // Continue-as-new before history grows unbounded. Do this at the top of the loop —
    // never mid-phase — so the re-seeded execution starts from a clean, resumable coordination
    // state. `state` carries everything the next run needs.
    if (state.condition === 'running' && workflowInfo().historyLength >= CONTINUE_AS_NEW_HISTORY_THRESHOLD) {
      await continueAsNew<typeof TaskWorkflow>({
        taskId: state.taskId,
        repositoryId: state.repositoryId,
        prompt: state.prompt,
        resumeState: state,
      });
    }

    // Bounded-autonomy stop check (TASK-105). If the loop exhausted its budget or is genuinely stuck
    // it must NOT keep looping and must NOT escalate to a human: divert to `release` so a draft PR
    // still opens, carrying an honest UnmetCriteria. Skip the diversion once we are already at/after
    // release (the release attempt itself is the terminal draft-PR action).
    if (state.condition === 'running' && !state.unmetCriteria && state.phase !== 'release') {
      const stopReason = evaluateLoopBudget(state, state.loopBudget ?? DEFAULT_LOOP_BUDGET, NO_PROGRESS_THRESHOLD);
      if (stopReason) {
        state = {
          ...state,
          unmetCriteria: buildUnmetCriteria({
            unprovenClaimIds: state.lastMissingClaimIds ?? [],
            stopReason,
            lastCandidateSha: state.lastCandidateSha,
          }),
          phase: 'release',
          attemptNumber: 0,
        };
        continue;
      }
    }

    state = { ...state, attemptNumber: state.attemptNumber + 1 };
    const phaseThatRan = state.phase;
    const result = await activities.runPhase({ phase: state.phase, state });

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
          lastCandidateSha: result.candidate.candidateSha ?? state.lastCandidateSha,
          // A phase advanced — clear the no-progress streak; this is real forward progress.
          noProgress: initialNoProgressState(),
        };
        // The specify candidate reports the classified size. Adopt it to derive the run's phase set.
        if (phaseThatRan === 'specify' && result.size && !state.sizeHumanOverridden) {
          state = { ...state, size: result.size, phaseSet: phaseSetForSize(result.size) };
        }
        // Release yielding a candidate means the draft PR is open — the terminal action. All claims
        // proven (or, when unmetCriteria was carried in, the honest met/unmet PR body was posted):
        // move to assimilate; the final block marks the run completed. Merge is out-of-band.
        state = { ...state, phase: nextPhase(state.phase, state.phaseSet), attemptNumber: 0 };
        break;
      }
      case 'repair': {
        // No escalation to a human (autonomy pivot). Fold this attempt's fingerprint into the
        // no-progress tracker so the next budget check can detect a genuinely-stuck edit/revert loop;
        // then route the repair. `repair` always targets `implement` (see @awb/domain).
        state = {
          ...state,
          noProgress: recordAttempt(
            state.noProgress ?? initialNoProgressState(),
            repairFingerprint(phaseThatRan, result.findings.map((f) => f.id)),
          ),
          phase: result.target,
          attemptNumber: 0,
        };
        break;
      }
      case 'replan': {
        state = { ...state, phase: result.target, attemptNumber: 0 };
        break;
      }
      case 'await-human': {
        // Retained outcome (e.g. an exercise qa-inconclusive evidence deficiency) — but the loop no
        // longer parks. Treat it as an unmet dependency and divert to a terminal draft PR: the human
        // reviews the honest checklist on the PR, not a workflow wait state.
        state = {
          ...state,
          unmetCriteria: buildUnmetCriteria({
            unprovenClaimIds: state.lastMissingClaimIds ?? [],
            stopReason: 'converged-unmet',
            lastCandidateSha: state.lastCandidateSha,
            unmetDependencies: [`${result.gate.phase}:${result.gate.reason}`],
          }),
          phase: 'release',
          attemptNumber: 0,
        };
        break;
      }
      case 'unmet-criteria': {
        // A phase (release on non-convergence) reported a terminal UnmetCriteria. Record it and move
        // to assimilate; the draft PR is already open with the met/unmet checklist.
        state = {
          ...state,
          unmetCriteria: result.unmetCriteria,
          lastCandidateSha: result.unmetCriteria.lastCandidateSha ?? state.lastCandidateSha,
          phase: nextPhase('release', state.phaseSet),
          attemptNumber: 0,
        };
        break;
      }
      case 'blocked': {
        // A hard block a re-run cannot fix (e.g. missing prerequisite). Terminal — no human gate.
        state = { ...state, condition: 'blocked' };
        cancelled = true;
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
