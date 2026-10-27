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
  CancelledFailure,
  TerminatedFailure,
  TimeoutFailure,
  isCancellation,
  log,
} from '@temporalio/workflow';
import {
  DEFAULT_LOOP_BUDGET,
  type TaskPhase,
  type LoopBudget,
  type UnmetCriteria,
  type UnmetCriterionReason,
  type PhaseAttemptResult,
  type TaskStateSync,
} from '@awb/domain';
import { nextPhaseIn, phaseSetForSize } from './phase-order.js';
import type { TaskWorkflowInput, TaskWorkflowState } from './workflow-types.js';
import { shouldStopLooping, exhaustedBudgetLimit } from './loop-routing.js';

export interface TaskActivities {
  runPhase(input: { phase: TaskPhase; state: TaskWorkflowState }): Promise<PhaseAttemptResult>;
  /**
   * Persists this Workflow's current phase/condition/delivery-state onto the task row (TASK-123).
   * The Activity is best-effort by contract — it never throws — so a monitoring write can never
   * fail a task.
   */
  syncTaskState(state: TaskStateSync): Promise<void>;
}

const activities = proxyActivities<TaskActivities>({
  startToCloseTimeout: '30 minutes',
  // A phase that stops making progress (e.g. a hung verify command, a wedged agent) must be detected
  // by liveness, not by the coarse 30-minute startToClose. This ceiling applies to EVERY phase, so
  // runPhase beats on a wall-clock interval for its whole duration (see PHASE_HEARTBEAT_INTERVAL_MS
  // in run-phase.ts) — a long-but-live phase keeps beating and survives; only a genuinely stuck one
  // goes silent, times out, retries, and is counted by the workflow (below). Do NOT heartbeat only at
  // command boundaries: a single long command then produces one silent gap wider than this ceiling
  // and a healthy phase is killed.
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

/**
 * Separate proxy for the task-state sync (TASK-123). It must NOT inherit the phase proxy's options:
 * a phase may legitimately run for 30 minutes and proves liveness by heartbeating, while this write
 * is a sub-second HTTP call that never heartbeats — under the phase proxy's 2-minute heartbeat
 * timeout it would be killed and retried for no reason. The Activity swallows daemon errors, so the
 * retries here only cover a worker crash or a wedged call.
 */
const stateSyncActivities = proxyActivities<Pick<TaskActivities, 'syncTaskState'>>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 2, initialInterval: '1 second' },
});

/**
 * Does this runPhase Activity exception mean "the phase is stuck" — i.e. should it be folded into the
 * no-progress streak and retried as a repair?
 *
 * TRUE for genuine execution failures: a heartbeat/start-to-close timeout (the hung-command case
 * TASK-105 exists for), a worker crash, an ApplicationFailure the phase threw, a ServerFailure.
 *
 * FALSE for control flow, which must propagate so the workflow unwinds:
 *   - CancelledFailure / cancellation scope — `awb task cancel`, or a parent cancelling us. Treating
 *     this as a repair would spin the phase loop instead of stopping it, and the cancel signal's own
 *     `condition: 'cancelled'` would be overwritten by the repair routing.
 *   - TerminatedFailure — the workflow was terminated outright; nothing left to repair.
 *
 * Temporal wraps the real reason as `ActivityFailure.cause`, so unwrap the chain before deciding.
 */
export function isRetryableStuckPhase(err: unknown): boolean {
  if (isCancellation(err)) {
    return false;
  }
  // Walk the cause chain: ActivityFailure -> (TimeoutFailure | CancelledFailure | ApplicationFailure | ...)
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof CancelledFailure || current instanceof TerminatedFailure) {
      return false;
    }
    current = current.cause;
  }
  return true;
}

/**
 * True when the Activity failed because it stopped heartbeating — the "genuinely stuck phase" signal
 * `heartbeatTimeout` exists to produce, as opposed to a phase that failed fast for its own reasons.
 * Reported on the gate so a stuck phase is legible, not just counted.
 */
export function isHeartbeatTimeout(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof TimeoutFailure && current.timeoutType === 'HEARTBEAT') {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Updates — synchronous, validated against current state before applying.
 *
 * Every approval Update is gone (TASK-104): the loop never waits for a human, so there is nothing to
 * approve. `extendBudget` survives, repurposed — it no longer releases a park, it raises the
 * `LoopBudget` of a run that is about to stop, and only while the run is still going.
 */
export const extendBudgetUpdate = defineUpdate<void, [{ additionalTokens?: number; additionalMinutes?: number }]>(
  'extendBudget',
);

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
export const getUnmetCriteriaQuery = defineQuery<TaskWorkflowState['unmetCriteria']>('getUnmetCriteria');

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
    // An intake size hint (CLI --size) PINS the size — it is the only override left (TASK-104), so
    // the classifier may not overwrite it. phaseSet stays undefined until specify derives it.
    size: input.size,
    sizePinnedAtIntake: input.size !== undefined,
    ...(input.size ? { phaseSet: phaseSetForSize(input.size, { disableProgramDesign: input.disableProgramDesign }) } : {}),
    // Stacked-PR base override (TASK-72); prepare/release read it off the coordination state.
    baseBranch: input.baseBranch,
    // A/B knob (TASK-61): threaded from config at start so the deterministic workflow can shape the
    // phase set without reading config live; drops program-design from the derived phaseSet.
    disableProgramDesign: input.disableProgramDesign,
    // The bound the autonomous loop runs under (TASK-105). Held in state so a continue-as-new
    // re-seed keeps the same budget rather than handing a stuck task a fresh one.
    loopBudget: input.loopBudget ?? DEFAULT_LOOP_BUDGET,
  };
}

/**
 * The phase every task ends in, whatever happened on the way there (TASK-106). Release opens (or
 * updates) the draft PR and renders the acceptance-claim report into its body, so a converged task
 * and a stuck one terminate the same way — on GitHub, where the human decides about merging.
 */
const TERMINAL_PHASE: TaskPhase = 'release';

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
  let budget: LoopBudget = state.loopBudget ?? DEFAULT_LOOP_BUDGET;

  /**
   * Stop the loop and route to the draft-PR terminal (TASK-105/106). The task does NOT end here: it
   * runs `release` one last time so a draft PR exists to carry the report. `stopped` makes that a
   * one-way door — a release that itself fails cannot re-enter the loop it was called to end.
   */
  let stopped = false;
  const stopLoop = (
    stopReason: UnmetCriteria['stopReason'],
    detail: string,
    extra?: { reasons?: UnmetCriterionReason[]; unprovenClaims?: string[]; findingIds?: string[] },
  ): void => {
    state = {
      ...state,
      unmetCriteria: {
        stopReason,
        phase: state.phase,
        unprovenClaims: extra?.unprovenClaims ?? [],
        reasons: extra?.reasons ?? [],
        findingIds: extra?.findingIds ?? state.openFindingIds,
        detail,
      },
      // `running`, not `awaiting-human`: the task is still working — it is opening its draft PR.
      condition: 'running',
      phase: TERMINAL_PHASE,
      attemptNumber: 0,
    };
    stopped = true;
  };

  // TASK-123: mirror every lifecycle transition onto the task row, so `awb fleet` reads the real
  // phase and condition instead of the values frozen at creation. `lastSynced` collapses the
  // consecutive identical writes the loop would otherwise make (the end-of-iteration sync and the
  // next iteration's entry sync carry the same triple) — a deterministic, replay-safe local.
  let lastSynced = '';
  const syncTaskState = async (): Promise<void> => {
    // The projection column keeps its `pending_gate_reason` name but now answers "which criterion
    // went unproven" (TASK-104) — nothing is pending on a human.
    const gateReason = state.unmetCriteria?.reasons[0] ?? null;
    const key = `${state.phase}|${state.condition}|${state.deliveryState}|${gateReason ?? ''}`;
    if (key === lastSynced) return;
    lastSynced = key;
    await stateSyncActivities.syncTaskState({
      taskId: state.taskId,
      repositoryId: state.repositoryId,
      prompt: state.prompt ?? '',
      phase: state.phase,
      condition: state.condition,
      deliveryState: state.deliveryState,
      pendingGateReason: gateReason,
    });
  };

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

  // Raises the budget of a run that is still going, so an operator who knows the task needs more
  // room grants it without restarting. It cannot revive a task that already stopped: the loop's
  // terminal is a draft PR, and reopening one would contradict TASK-106.
  setHandler(extendBudgetUpdate, (args) => {
    if (state.unmetCriteria) {
      throw ApplicationFailure.nonRetryable('This task already terminated; start a retry task instead');
    }
    state = {
      ...state,
      loopBudget: {
        maxAttemptsPerPhase: budget.maxAttemptsPerPhase,
        maxTotalTokens: budget.maxTotalTokens + (args?.additionalTokens ?? 0),
        maxWallClockMs: budget.maxWallClockMs + (args?.additionalMinutes ?? 0) * 60_000,
      },
    };
    budget = state.loopBudget as LoopBudget;
    failureStreak.clear();
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
  setHandler(getUnmetCriteriaQuery, () => state.unmetCriteria);

  while (!cancelled && state.phase !== 'assimilate') {
    await condition(() => !paused || cancelled);
    if (cancelled) break;

    // The wall-clock budget's origin. Set on the first iteration only, and carried across a
    // continue-as-new, so a re-seed cannot hand a long-running task a fresh clock.
    if (state.loopStartedAtMs === undefined) {
      state = { ...state, loopStartedAtMs: Date.now() };
    }

    // Budget check (TASK-105) — before spending another attempt, not after. Skipped once the loop
    // has already stopped: the terminal release attempt must run even on an exhausted budget, or
    // there would be no draft PR to carry the report.
    if (!stopped) {
      const exhausted = exhaustedBudgetLimit(
        {
          attemptsAtPhase: state.attemptsByPhase?.[state.phase] ?? 0,
          totalTokens: state.tokenUsageTotal.inputTokens + state.tokenUsageTotal.outputTokens,
          elapsedMs: Date.now() - (state.loopStartedAtMs ?? Date.now()),
        },
        budget,
      );
      if (exhausted && shouldStopLooping({ kind: 'budget-exhaustion' })) {
        stopLoop(
          'budget-exhausted',
          `The loop reached its ${exhausted} budget at phase ${state.phase} after ${state.attemptsByPhase?.[state.phase] ?? 0} attempt(s).`,
          { reasons: ['budget-exceeded'] },
        );
      }
    }

    // Continue-as-new before history grows unbounded. Do this at the top of the loop —
    // never mid-phase — and only while running with no pending gate, so the re-seeded execution
    // starts from a clean, resumable coordination state. `state` carries everything the next run needs.
    if (
      state.condition === 'running' &&
      !stopped &&
      workflowInfo().historyLength >= CONTINUE_AS_NEW_HISTORY_THRESHOLD
    ) {
      await continueAsNew<typeof TaskWorkflow>({
        taskId: state.taskId,
        repositoryId: state.repositoryId,
        prompt: state.prompt,
        resumeState: state,
      });
    }

    state = {
      ...state,
      attemptNumber: state.attemptNumber + 1,
      attemptsByPhase: {
        ...state.attemptsByPhase,
        [state.phase]: (state.attemptsByPhase?.[state.phase] ?? 0) + 1,
      },
    };
    // Entry sync: records the phase about to run, and clears a gate reason a human just resolved.
    await syncTaskState();
    const phaseThatRan = state.phase;
    let result: PhaseAttemptResult;
    try {
      result = await activities.runPhase({ phase: state.phase, state });
    } catch (err) {
      // The Activity exhausted its retries. A STUCK phase (a hung command that stopped heartbeating,
      // or a crashed/timed-out attempt) is folded into the SAME no-progress accounting a repaired
      // failure uses, so it surfaces as a counted `repeated-failure-no-progress` gate rather than a
      // silent "attempt 1" replay or a workflow crash.
      //
      // But NOT every exception means "stuck". Cancellation and termination are control-flow, not
      // failure: swallowing them would make `awb task cancel` look like a repair and spin the loop
      // instead of stopping it. Re-throw those so the workflow unwinds as Temporal intends.
      if (!isRetryableStuckPhase(err)) {
        throw err;
      }
      // Make a stuck phase legible: a heartbeat timeout is the "went silent" case, distinct from a
      // phase that failed fast for its own reasons. `findings` is a ref list, not free text, so this
      // detail belongs in the log rather than the routing result.
      log.warn('runPhase failed after exhausting retries — counting as no-progress repair', {
        phase: phaseThatRan,
        attemptNumber: state.attemptNumber,
        heartbeatTimeout: isHeartbeatTimeout(err),
      });
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
        // phase set — UNLESS the caller pinned a size at intake, which wins.
        if (phaseThatRan === 'specify' && result.size && !state.sizePinnedAtIntake) {
          state = {
            ...state,
            size: result.size,
            phaseSet: phaseSetForSize(result.size, { disableProgramDesign: state.disableProgramDesign }),
          };
        }
        failureStreak.delete(state.phase);
        // A candidate from the terminal release phase means the draft PR is open — the task is done,
        // whether or not its report says every claim was proven (TASK-106). Merging happens
        // out-of-band on GitHub, so the workbench records the delivery and stops.
        state = {
          ...state,
          ...(phaseThatRan === TERMINAL_PHASE ? { deliveryState: 'draft-pr-open' as const } : {}),
          phase: nextPhase(state.phase, state.phaseSet),
          attemptNumber: 0,
        };
        break;
      }
      case 'repair': {
        // The terminal release attempt must never loop back: it exists only to open the draft PR.
        if (stopped) {
          state = { ...state, phase: 'assimilate', attemptNumber: 0 };
          break;
        }
        const streak = (failureStreak.get(state.phase) ?? 0) + 1;
        failureStreak.set(state.phase, streak);
        // The same failure, this many times, with nothing moving between attempts: this is the
        // "genuinely stuck" signal, and it stops the loop rather than parking it on a human.
        if (shouldStopLooping({ kind: 'repeated-identical-failure', occurrences: streak, threshold: NO_PROGRESS_THRESHOLD })) {
          stopLoop(
            'genuinely-stuck',
            `The ${phaseThatRan} phase failed ${streak} times with no progress between attempts.`,
            {
              reasons: ['repeated-failure-no-progress'],
              findingIds: result.findings.map((f) => f.id),
            },
          );
        } else {
          // PhaseAttemptResult's "repair" outcome always targets "implement" (see @awb/domain) —
          // routeLoop's per-finding-category table applies to "replan"/"challenge", not here.
          state = { ...state, phase: result.target, attemptNumber: 0 };
        }
        break;
      }
      case 'replan': {
        if (stopped) {
          state = { ...state, phase: 'assimilate', attemptNumber: 0 };
          break;
        }
        state = { ...state, phase: result.target, attemptNumber: 0 };
        break;
      }
      case 'unmet': {
        // A phase proved it cannot satisfy a claim. No further iteration helps, so stop the loop and
        // carry the reason to the draft PR — the replacement for the old `awaiting-human` park.
        if (stopped) {
          state = { ...state, phase: 'assimilate', attemptNumber: 0 };
          break;
        }
        stopLoop('converged-unmet', result.detail, {
          reasons: [result.reason],
          unprovenClaims: result.unprovenClaims,
          findingIds: result.findings.map((f) => f.id),
        });
        break;
      }
      case 'blocked': {
        if (stopped) {
          state = { ...state, phase: 'assimilate', attemptNumber: 0 };
          break;
        }
        stopLoop('phase-blocked', `The ${phaseThatRan} phase reported blocked: ${result.reason}`);
        break;
      }
      case 'cancelled': {
        cancelled = true;
        state = { ...state, condition: 'cancelled' };
        break;
      }
    }

    // Exit sync: records where the routing just sent the task — the next phase, a loop-back target,
    // the draft-PR terminal a stopped loop routes to, or a cancellation.
    await syncTaskState();
  }

  if (state.phase === 'assimilate' && state.condition !== 'cancelled') {
    // A task that stopped short of proving every claim still reached its draft PR, but calling it
    // `completed` would hide exactly what a reader needs to see. `failed` is the honest terminal:
    // the work is delivered and reviewable, and the fleet view flags it for a look.
    state = { ...state, condition: state.unmetCriteria ? 'failed' : 'completed' };
  }

  // Terminal sync. This state is decided AFTER the phase loop, so no runPhase Activity can ever
  // observe it — the reason the task-state write is its own Activity rather than a fold into runPhase.
  await syncTaskState();

  return state;
}

function nextPhase(phase: TaskPhase, phaseSet: TaskPhase[] | undefined): TaskPhase {
  return nextPhaseIn(phaseSet, phase);
}

