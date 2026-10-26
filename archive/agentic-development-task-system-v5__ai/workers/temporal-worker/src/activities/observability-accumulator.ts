import { randomUUID } from 'node:crypto';
import type {
  RuntimeAttribution,
  ContextComposition,
  AgentSessionRecord,
  PhaseObservability,
  PhaseAttemptOutcome,
  TaskPhase,
  ModelUsage,
} from '@awb/domain';

export type AttributionBucket = keyof RuntimeAttribution;

const ZERO_ATTRIBUTION: RuntimeAttribution = {
  environmentSetupMs: 0,
  dependencyInstallMs: 0,
  modelWaitMs: 0,
  modelGenerationMs: 0,
  toolExecutionMs: 0,
  testExecutionMs: 0,
  serviceStartupMs: 0,
  qaExecutionMs: 0,
  artifactProcessingMs: 0,
  githubOperationMs: 0,
  humanWaitMs: 0,
  retryBackoffMs: 0,
};

/**
 * Per-phase-attempt observability accumulator. Handlers add wall-clock into the
 * 12 runtime-attribution buckets at the natural seams (model turns, test/QA execution, dependency
 * install, github ops, …) and register each agent session (its model invocations + context makeup).
 * The driver drains it into a `PhaseObservability` payload the daemon persists. A fresh instance per
 * `runPhase` invocation, carried on `PhaseContext`.
 */
export class ObservabilityAccumulator {
  private readonly attribution: RuntimeAttribution = { ...ZERO_ATTRIBUTION };
  private readonly sessions: AgentSessionRecord[] = [];

  /** Add elapsed ms to a runtime-attribution bucket. */
  add(bucket: AttributionBucket, ms: number): void {
    if (ms > 0) this.attribution[bucket] += Math.round(ms);
  }

  /** Time an async operation into a bucket. */
  async time<T>(bucket: AttributionBucket, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.add(bucket, Date.now() - start);
    }
  }

  /**
   * Record one agent session's observability. `usage` is the ModelUsage the adapter reported (may be
   * undefined on the mock runtime); when present it becomes a single model_invocations row. The
   * model-generation time is added to that bucket here so callers don't double-count.
   */
  recordSession(input: {
    sessionId: string;
    taskId: string;
    runId: string;
    phaseAttemptId: string;
    phase: TaskPhase;
    role: AgentSessionRecord['role'];
    runtime: string;
    usage?: ModelUsage;
    runtimeMs: number;
    /**
     * Epoch ms at which the adapter execution began. The session's real interval — persisted as
     * `started_at`/`ended_at` — is derived from this and `runtimeMs`. Omit it only when no start was
     * measured; the interval is then reconstructed backwards from `runtimeMs`.
     */
    startedAtMs?: number;
    contextComposition?: ContextComposition;
    /** Provider resume token for this session; persisted so a retry resumes the transcript. */
    resumeSessionId?: string;
  }): void {
    const endedAtMs = Date.now();
    const startedAtMs = input.startedAtMs ?? endedAtMs - input.runtimeMs;
    const startedAt = new Date(startedAtMs).toISOString();
    const endedAt = new Date(Math.max(endedAtMs, startedAtMs)).toISOString();
    this.add('modelGenerationMs', input.runtimeMs);
    this.sessions.push({
      id: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      phaseAttemptId: input.phaseAttemptId,
      phase: input.phase,
      role: input.role,
      runtime: input.runtime,
      ...(input.usage?.model ? { model: input.usage.model } : {}),
      ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      startedAt,
      endedAt,
      modelInvocations: input.usage
        ? [
            {
              id: randomUUID(),
              provider: input.usage.provider,
              model: input.usage.model,
              inputTokens: input.usage.inputTokens,
              outputTokens: input.usage.outputTokens,
              ...(input.usage.cachedInputTokens !== undefined
                ? { cachedInputTokens: input.usage.cachedInputTokens }
                : {}),
              ...(input.usage.cacheCreationInputTokens !== undefined
                ? { cacheCreationInputTokens: input.usage.cacheCreationInputTokens }
                : {}),
              ...(input.usage.costUsd !== undefined ? { costUsd: input.usage.costUsd } : {}),
              startedAt,
              // No in-tree adapter reports a per-invocation boundary: `AgentExecutionResult.usage` is
              // aggregate for the whole execution (the Claude adapter emits one `usage` event at the
              // terminal `result` message). Leave `endedAt` unset so the column is an honest NULL
              // rather than a fabricated zero-duration equal to `startedAt`.
            },
          ]
        : [],
      ...(input.contextComposition
        ? { contextComposition: reconcileContextComposition(input.contextComposition, input.usage) }
        : {}),
    });
  }

  /**
   * Build the payload for /internal/observability, or undefined when nothing was recorded AND the
   * attempt is not being closed. An attempt that records no sessions and no wall-clock still has to
   * close (TASK-124), so close fields alone are enough to produce a payload — that is the throw path.
   */
  toPayload(input: {
    taskId: string;
    runId: string;
    phaseAttemptId: string;
    phase: TaskPhase;
    attemptNumber: number;
    startedAt?: string;
    endedAt?: string;
    outcome?: PhaseAttemptOutcome;
  }): PhaseObservability | undefined {
    const hasAttribution = Object.values(this.attribution).some((v) => v > 0);
    const closes = input.endedAt !== undefined || input.outcome !== undefined;
    if (!hasAttribution && this.sessions.length === 0 && !closes) return undefined;
    return {
      taskId: input.taskId,
      runId: input.runId,
      phaseAttemptId: input.phaseAttemptId,
      phase: input.phase,
      attemptNumber: input.attemptNumber,
      runtimeAttribution: { ...this.attribution },
      sessions: this.sessions,
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    };
  }
}

/**
 * Coarse context-composition estimate from an agent session's contextPayload. Token count
 * is approximated as chars/4 (the standard rough heuristic — exact tokenization would need the model's
 * tokenizer and isn't worth it for a UI breakdown). Maps the payload's known shapes to buckets.
 */
export function estimateContextComposition(
  contextPayload: unknown,
  instruction: string,
): ContextComposition {
  const tokens = (v: unknown): number => {
    if (v === undefined || v === null) return 0;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return Math.ceil(s.length / 4);
  };
  const payload = (contextPayload ?? {}) as Record<string, unknown>;
  return {
    contractTokens: tokens(payload.contract),
    planTokens: tokens(payload.plan),
    diffTokens: tokens(payload.diff),
    evidenceTokens: tokens(payload.evidence ?? payload.verificationEvidence ?? payload.qaEvidence),
    findingsTokens: tokens(payload.findings ?? payload.priorFindings),
    repositoryMapTokens: tokens(payload.repositoryMap),
    memoryTokens: tokens(payload.memory),
    instructionTokens: tokens(instruction),
    // A chars/4 heuristic until reconcileContextComposition scales it to a measured inputTokens total.
    estimated: true,
  };
}

/** The 8 chars/4 buckets, in the order they are scaled and rounded. */
const CONTEXT_BUCKETS = [
  'contractTokens',
  'planTokens',
  'diffTokens',
  'evidenceTokens',
  'findingsTokens',
  'repositoryMapTokens',
  'memoryTokens',
  'instructionTokens',
] as const satisfies ReadonlyArray<keyof Omit<ContextComposition, 'estimated'>>;

/**
 * Reconcile a chars/4 estimate against the provider-reported usage. When `usage.inputTokens` is
 * available, scale the 8 estimated buckets so they SUM to that measured fresh-input total
 * (largest-remainder rounding keeps the sum exact) and flag `estimated: false`. Cache-read tokens
 * (`usage.cachedInputTokens`) are billed and attributed separately on the model_invocations row —
 * they are NOT folded into these buckets, so "context we paid to re-send" stays distinguishable from
 * fresh input. With no usage (mock runtime) the estimate passes through flagged `estimated: true`.
 */
export function reconcileContextComposition(
  estimate: ContextComposition,
  usage: ModelUsage | undefined,
): ContextComposition {
  const measured = usage?.inputTokens;
  if (measured === undefined) return { ...estimate, estimated: true };

  const estimatedTotal = CONTEXT_BUCKETS.reduce((sum, k) => sum + estimate[k], 0);
  if (estimatedTotal <= 0) {
    // Nothing to scale (all buckets zero); attribute the whole measured total to instruction so the
    // sum still reconciles, and mark it measured.
    return { ...estimate, instructionTokens: measured, estimated: false };
  }

  // Scale each bucket by measured/estimatedTotal, then distribute the rounding remainder to the
  // buckets with the largest fractional parts so the reconciled buckets sum EXACTLY to `measured`.
  const parts = CONTEXT_BUCKETS.map((bucket) => {
    const scaled = (estimate[bucket] * measured) / estimatedTotal;
    const floor = Math.floor(scaled);
    return { bucket, floor, frac: scaled - floor };
  });
  let remainder = measured - parts.reduce((sum, p) => sum + p.floor, 0);
  const reconciled: ContextComposition = { ...estimate, estimated: false };
  for (const p of parts) {
    reconciled[p.bucket] = p.floor;
  }
  for (const p of [...parts].sort((a, b) => b.frac - a.frac)) {
    if (remainder <= 0) break;
    reconciled[p.bucket] += 1;
    remainder -= 1;
  }
  return reconciled;
}
