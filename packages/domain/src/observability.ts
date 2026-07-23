import { z } from 'zod';
import { TaskPhaseSchema } from './lifecycle.js';

/** The 12 runtime-attribution buckets (spec §27) — where a phase attempt's wall-clock went. */
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

/** The 8 context-composition buckets (spec §27) — token count by source in an assembled context. */
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
      costUsd: z.number().nonnegative().optional(),
      startedAt: z.string(),
      endedAt: z.string().optional(),
    }),
  ),
  contextComposition: ContextCompositionSchema.optional(),
});
export type AgentSessionRecord = z.infer<typeof AgentSessionRecordSchema>;

/** The observability payload the worker posts to the daemon at the end of a phase attempt (spec §27). */
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

/** By-model token/cost rollup for `task show` (spec §27 "not just the flat total"). */
export const TokenBreakdownSchema = z.object({
  totals: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
  byModel: z.record(
    z.string(),
    z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
  ),
});
export type TokenBreakdown = z.infer<typeof TokenBreakdownSchema>;
