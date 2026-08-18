import { z } from 'zod';
import { TaskPhaseSchema } from './lifecycle.js';

/** The 12 runtime-attribution buckets — where a phase attempt's wall-clock went. */
export const RuntimeAttributionSchema = z.object({
  environmentSetupMs: z.number().int().nonnegative().default(0),
  dependencyInstallMs: z.number().int().nonnegative().default(0),
  modelWaitMs: z.number().int().nonnegative().default(0),
  modelGenerationMs: z.number().int().nonnegative().default(0),
  toolExecutionMs: z.number().int().nonnegative().default(0),
  testExecutionMs: z.number().int().nonnegative().default(0),
  serviceStartupMs: z.number().int().nonnegative().default(0),
  qaExecutionMs: z.number().int().nonnegative().default(0),
  artifactProcessingMs: z.number().int().nonnegative().default(0),
  githubOperationMs: z.number().int().nonnegative().default(0),
  humanWaitMs: z.number().int().nonnegative().default(0),
  retryBackoffMs: z.number().int().nonnegative().default(0),
});
export type RuntimeAttribution = z.infer<typeof RuntimeAttributionSchema>;

/** The 8 context-composition buckets — token count by source in an assembled context. */
export const ContextCompositionSchema = z.object({
  contractTokens: z.number().int().nonnegative().default(0),
  planTokens: z.number().int().nonnegative().default(0),
  diffTokens: z.number().int().nonnegative().default(0),
  evidenceTokens: z.number().int().nonnegative().default(0),
  findingsTokens: z.number().int().nonnegative().default(0),
  repositoryMapTokens: z.number().int().nonnegative().default(0),
  memoryTokens: z.number().int().nonnegative().default(0),
  instructionTokens: z.number().int().nonnegative().default(0),
});
export type ContextComposition = z.infer<typeof ContextCompositionSchema>;

export const AgentSessionRoleSchema = z.enum([
  'planner',
  'plan-critic',
  'builder',
  'verifier',
  'qa-executor',
  'adversarial-reviewer',
]);
export type AgentSessionRoleName = z.infer<typeof AgentSessionRoleSchema>;

/** One agent session's observability record: identity, its model invocations, and context makeup. */
export const AgentSessionRecordSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string(),
  phaseAttemptId: z.string(),
  phase: TaskPhaseSchema,
  role: AgentSessionRoleSchema,
  runtime: z.string(),
  model: z.string().optional(),
  /** The provider's resumable session token for this session; persisted for retry resume. */
  resumeSessionId: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  modelInvocations: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      model: z.string(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      cacheCreationInputTokens: z.number().int().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
      startedAt: z.string(),
      endedAt: z.string().optional(),
    }),
  ),
  contextComposition: ContextCompositionSchema.optional(),
});
export type AgentSessionRecord = z.infer<typeof AgentSessionRecordSchema>;

/** The observability payload the worker posts to the daemon at the end of a phase attempt. */
export const PhaseObservabilitySchema = z.object({
  taskId: z.string(),
  runId: z.string(),
  phaseAttemptId: z.string(),
  phase: TaskPhaseSchema,
  attemptNumber: z.number().int().nonnegative(),
  runtimeAttribution: RuntimeAttributionSchema,
  sessions: z.array(AgentSessionRecordSchema),
});
export type PhaseObservability = z.infer<typeof PhaseObservabilitySchema>;

/** By-model token/cost rollup for `task show` ("not just the flat total"). */
export const TokenBreakdownSchema = z.object({
  totals: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
  byModel: z.record(
    z.string(),
    z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative(),
      cacheCreationInputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
  ),
});
export type TokenBreakdown = z.infer<typeof TokenBreakdownSchema>;

/**
 * Per-phase token spend (TASK-79): one row per phase with the cache split (fresh / cache-read /
 * cache-write) and the context-composition split (static instruction/prompt scaffolding vs injected
 * task-specific context). `phase` is `'(totals)'` on the aggregate row. Used to rank the top-offender
 * phases for prompt/context reduction.
 */
export const PhaseTokenSpendSchema = z.object({
  phase: z.string(),
  /** Fresh (uncached) input tokens billed at the base input rate. */
  freshInputTokens: z.number().int().nonnegative(),
  /** Cache READ input tokens (a re-sent cached prefix; ~0.1× input). */
  cacheReadTokens: z.number().int().nonnegative(),
  /** Cache WRITE input tokens (first-seen prefix written to cache; ~1.25× input). */
  cacheCreationTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Static context: the fixed prompt/instruction scaffolding (`instructionTokens`). */
  staticContextTokens: z.number().int().nonnegative(),
  /** Injected context: task-specific material (contract/plan/diff/evidence/findings/repo-map/memory). */
  injectedContextTokens: z.number().int().nonnegative(),
});
export type PhaseTokenSpend = z.infer<typeof PhaseTokenSpendSchema>;

export const TokenSpendByPhaseSchema = z.object({
  byPhase: z.array(PhaseTokenSpendSchema),
  totals: PhaseTokenSpendSchema,
});
export type TokenSpendByPhase = z.infer<typeof TokenSpendByPhaseSchema>;
