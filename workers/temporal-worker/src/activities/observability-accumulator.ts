import { randomUUID } from 'node:crypto';
import type {
  RuntimeAttribution,
  ContextComposition,
  AgentSessionRecord,
  PhaseObservability,
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
 * Per-phase-attempt observability accumulator (spec §27, TASK-22). Handlers add wall-clock into the
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
    contextComposition?: ContextComposition;
    /** Provider resume token for this session (TASK-32); persisted so a retry resumes the transcript. */
    resumeSessionId?: string;
  }): void {
    const now = new Date().toISOString();
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
      startedAt: now,
      endedAt: now,
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
              startedAt: now,
              endedAt: now,
            },
          ]
        : [],
      ...(input.contextComposition ? { contextComposition: input.contextComposition } : {}),
    });
  }

  /** Build the payload for /internal/observability, or undefined when nothing was recorded. */
  toPayload(input: {
    taskId: string;
    runId: string;
    phaseAttemptId: string;
    phase: TaskPhase;
    attemptNumber: number;
  }): PhaseObservability | undefined {
    const hasAttribution = Object.values(this.attribution).some((v) => v > 0);
    if (!hasAttribution && this.sessions.length === 0) return undefined;
    return {
      taskId: input.taskId,
      runId: input.runId,
      phaseAttemptId: input.phaseAttemptId,
      phase: input.phase,
      attemptNumber: input.attemptNumber,
      runtimeAttribution: { ...this.attribution },
      sessions: this.sessions,
    };
  }
}

/**
 * Coarse context-composition estimate (spec §27) from an agent session's contextPayload. Token count
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
  };
}
