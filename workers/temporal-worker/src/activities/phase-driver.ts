import type {
  TaskPhase,
  TaskSize,
  PhaseAttemptResult,
  CompletionCandidate,
  ModelUsage,
  PhaseUsage,
} from '@awb/domain';
import type { TaskWorkflowState } from '@awb/workflow';
import { evaluatePhaseCompletion, type CompletionContext } from '@awb/workflow';
import type { AgentRuntime, RuntimeProfile } from './agent-factory.js';
import type { RunStateStore, TaskRunState } from './run-state-store.js';
import type { ObservabilityAccumulator } from './observability-accumulator.js';
import type { DaemonClient } from '../daemon-client.js';
import type { ControlPlaneEmitter } from './control-plane-events.js';
import { runIdForTask } from '@awb/database';

/**
 * Per-runPhase-invocation usage accumulator, carried on the driver's `PhaseContext`
 * instead of a module-level global. Each phase's agent sessions call `record` with the
 * adapter's reported tokens + measured wall-clock; the driver reads `forResult()` back and attaches
 * it to the PhaseAttemptResult so the Workflow can accumulate `tokenUsageTotal` + `runtimeMsByPhase`.
 * A fresh instance per invocation removes the reset-a-global dance the old code needed.
 */
export class UsageAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private runtimeMs = 0;

  record(usage: ModelUsage | undefined, runtimeMs: number): void {
    this.inputTokens += usage?.inputTokens ?? 0;
    this.outputTokens += usage?.outputTokens ?? 0;
    this.runtimeMs += runtimeMs;
  }

  forResult(): PhaseUsage | undefined {
    if (this.inputTokens === 0 && this.outputTokens === 0 && this.runtimeMs === 0) {
      return undefined;
    }
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens, runtimeMs: this.runtimeMs };
  }
}

/**
 * Phase-level lifecycle event the driver emits around every attempt. This is the single hook a real
 * `SemanticEventBus`/SQLite sink wires into; today it defaults to a no-op so behavior is
 * unchanged (only per-agent-turn events reach a sink; there is no phase-level event yet). The
 * `phase.completed` event carries the rolled-up usage so it can be routed to `UsageAggregator`
 * without reaching into a global.
 */
export type PhaseEvent =
  | { kind: 'phase.started'; taskId: string; phase: TaskPhase; attemptNumber: number }
  | {
      kind: 'phase.completed';
      taskId: string;
      phase: TaskPhase;
      attemptNumber: number;
      outcome: PhaseAttemptResult['outcome'];
      usage?: PhaseUsage;
    };

export type PhaseEventEmitter = (event: PhaseEvent) => void;

export const NOOP_PHASE_EVENT_EMITTER: PhaseEventEmitter = () => {};

/**
 * Everything a phase handler needs for one attempt, threaded by the driver: the Workflow state, the
 * task's accumulated `TaskRunState`, the store (so a handler that mutates `runState` persists it),
 * the runtime strategy resolved ONCE at driver entry (so no handler re-decides real-vs-mock per
 * phase), the per-invocation usage accumulator (was a module global), and the
 * phase-event emitter seam.
 */
export interface PhaseContext {
  state: TaskWorkflowState;
  runState: TaskRunState;
  store: RunStateStore;
  /**
   * The selected runtime name, kept for adapter selection + the observability `runtime:` label. Do
   * NOT branch real-vs-mock on this (that was the anti-pattern) — ask `profile` instead.
   */
  strategy: AgentRuntime;
  /**
   * The RuntimeProfile for `strategy`, resolved once at driver entry. Every real-vs-mock
   * decision in a phase handler routes through a capability on this profile (`usesRealAgent`,
   * `usesRealWorktree`, `usesDurableRunState`, `usesSdkToolNames`) so "run the real path" is a
   * property of the selected runtime, not a string equality on one vendor's name.
   */
  profile: RuntimeProfile;
  usage: UsageAccumulator;
  emit: PhaseEventEmitter;
  /** Runtime-attribution + per-session observability for this attempt. */
  observability: ObservabilityAccumulator;
  /** Daemon client for persisting observability; undefined on the mock path (nothing to persist). */
  daemon?: DaemonClient;
  /**
   * Control-plane lifecycle emitter so a handler can emit session-started/session-resumed
   * with the cwd + resume key each session ran under. Undefined on the mock path (no daemon to post to).
   */
  controlPlane?: ControlPlaneEmitter;
}

/**
 * What a handler returns. `early` short-circuits before completion evaluation (the per-phase
 * await-human/repair/replan/blocked outcomes that some phases return before ever evaluating —
 * specify attempt 1, plan non-convergence, verify/exercise repair, challenge repair/replan, release
 * pr-readiness, and the various guard clauses). `evaluate` hands the driver the phase-specific
 * `CompletionContext` + the evidence/finding IDs, and the driver builds the boilerplate
 * `CompletionCandidate`, calls `evaluatePhaseCompletion` once, and maps the decision.
 */
export type PhaseOutcome =
  | { kind: 'early'; result: PhaseAttemptResult }
  | {
      kind: 'evaluate';
      completion: CompletionContext;
      evidenceIds: string[];
      openFindingIds: string[];
      /** Overrides for the completion candidate literal (versions/SHAs); the rest is boilerplate. */
      candidateOverrides?: Partial<CompletionCandidate>;
      /**
       * Extra fields to attach to a `candidate` PhaseAttemptResult beyond the candidate itself:
       * specify uses this to report the classified `size` to the Workflow. Ignored on a
       * non-complete (blocked) decision.
       */
      candidateExtra?: { size?: TaskSize };
      /** How to map a non-complete decision; defaults to `blockedResult(phase, missing)`. */
      onBlocked?: (missing: string[]) => PhaseAttemptResult;
    };

export interface PhaseHandler {
  phase: TaskPhase;
  run(ctx: PhaseContext): Promise<PhaseOutcome>;
}

/**
 * Builds the `CompletionCandidate` literal that was copy-pasted into all nine phases. The constant
 * fields (`repositorySnapshotId`, `policyVersion`, `artifactManifestHash`, default versions) live
 * here once; phase-specific bits (evidence/finding IDs, real SHAs, real contract/plan versions)
 * arrive via `overrides`.
 */
export function buildPhaseAttempt(
  state: TaskWorkflowState,
  phase: TaskPhase,
  evidenceIds: string[],
  openFindingIds: string[],
  overrides: Partial<CompletionCandidate> = {},
): CompletionCandidate {
  return {
    phase,
    phaseAttemptId: `${state.taskId}-${phase}-${state.attemptNumber}`,
    repositorySnapshotId: `${state.repositoryId}-snapshot`,
    contractVersion: 1,
    planVersion: 1,
    policyVersion: 'v1',
    evidenceIds,
    openFindingIds,
    artifactManifestHash: 'run-phase-mvp',
    ...overrides,
  };
}

export function candidateResult(candidate: CompletionCandidate): PhaseAttemptResult {
  return { outcome: 'candidate', candidate };
}

export function blockedResult(phase: TaskPhase, missing: string[]): PhaseAttemptResult {
  return {
    outcome: 'blocked',
    reason: `Phase "${phase}" is not complete per evaluatePhaseCompletion: ${missing.join('; ')}`,
  };
}

/**
 * The shared driver factored out of the nine `runX` functions: emit `phase.started`, run the
 * handler, and for the `evaluate` path build the boilerplate candidate, call
 * `evaluatePhaseCompletion` once, and map the decision (complete → candidate; else → the handler's
 * `onBlocked` or `blockedResult`). Handler mutations to `ctx.runState` are persisted via the store,
 * the accumulated usage is attached to the result, and `phase.completed` is emitted with it.
 */
export async function drivePhase(handler: PhaseHandler, ctx: PhaseContext): Promise<PhaseAttemptResult> {
  ctx.emit({
    kind: 'phase.started',
    taskId: ctx.state.taskId,
    phase: handler.phase,
    attemptNumber: ctx.state.attemptNumber,
  });

  const outcome = await handler.run(ctx);

  let result: PhaseAttemptResult;
  if (outcome.kind === 'early') {
    result = outcome.result;
  } else {
    const candidate = buildPhaseAttempt(
      ctx.state,
      handler.phase,
      outcome.evidenceIds,
      outcome.openFindingIds,
      outcome.candidateOverrides,
    );
    const decision = evaluatePhaseCompletion(candidate, outcome.completion);
    if (decision.complete) {
      result = candidateResult(candidate);
      // Attach the classified size so the Workflow can derive the run's phase set.
      if (outcome.candidateExtra?.size && result.outcome === 'candidate') {
        result = { ...result, size: outcome.candidateExtra.size };
      }
    } else {
      result = outcome.onBlocked
        ? outcome.onBlocked(decision.missing)
        : blockedResult(handler.phase, decision.missing);
    }
  }

  // Persist AFTER the result is computed so run-state mutations made inside `onBlocked` (e.g. the
  // exercise gate stashing repair feedback for the next implement attempt) are saved, not just the
  // handler-body mutations.
  await ctx.store.save(ctx.state.taskId, ctx.runState);

  // Attach the agent usage this attempt accumulated so the Workflow can aggregate token +
  // per-phase runtime totals. undefined when no agent session ran (or on the mock
  // runtime, whose adapter reports no usage) — the Workflow simply skips accumulation then.
  const usage = ctx.usage.forResult();
  if (usage) result = { ...result, usage };

  ctx.emit({
    kind: 'phase.completed',
    taskId: ctx.state.taskId,
    phase: handler.phase,
    attemptNumber: ctx.state.attemptNumber,
    outcome: result.outcome,
    usage,
  });

  // Persist observability for this attempt (runtime-attribution buckets + agent sessions +
  // model invocations + context composition). Best-effort: a failed persist never fails the phase.
  if (ctx.daemon) {
    const payload = ctx.observability.toPayload({
      taskId: ctx.state.taskId,
      runId: runIdForTask(ctx.state.taskId),
      phaseAttemptId: `${ctx.state.taskId}-${handler.phase}-${ctx.state.attemptNumber}`,
      phase: handler.phase,
      attemptNumber: ctx.state.attemptNumber,
    });
    if (payload) {
      try {
        await ctx.daemon.postObservability(payload);
      } catch {
        // best-effort observability
      }
    }
  }

  return result;
}
