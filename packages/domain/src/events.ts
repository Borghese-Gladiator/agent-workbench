import { z } from 'zod';
import { TaskPhaseSchema } from './lifecycle.js';

export const EventProducerSchema = z.enum([
  'workflow',
  'planner',
  'plan-critic',
  'builder',
  'verifier',
  'qa',
  'reviewer',
  'tool',
  // The control plane itself (run-phase driver / retry boundary), distinct from any agent role.
  // Emits lifecycle events (phase started/failed, retry scheduled, transport drop).
  'workbench',
]);
export type EventProducer = z.infer<typeof EventProducerSchema>;

export const EventTypeSchema = z.enum([
  'intent',
  'plan-item-started',
  'command-started',
  'command-completed',
  'file-changed',
  'finding-created',
  'evidence-created',
  'usage-reported',
  'status-changed',
  'message',
  // Control-plane lifecycle events — emitted by the 'workbench' producer, not an agent.
  // These make a phase failing / retrying / a transport drop first-class in the durable stream
  // instead of an undifferentiated 'message' or a stderr-only [WARN] line.
  'phase-started',
  'phase-failed',
  'attempt-retry-scheduled',
  'transport-error',
  'session-started',
  'session-resumed',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const SemanticEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.string(),
  phase: TaskPhaseSchema,
  phaseAttemptId: z.string(),
  producer: EventProducerSchema,
  type: EventTypeSchema,
  summary: z.string(),
  payloadJson: z.unknown().optional(),
  artifactId: z.string().optional(),
});
export type SemanticEvent = z.infer<typeof SemanticEventSchema>;

// The three input-token counts are the halves of provider prompt caching and are billed at very
// different rates; keep them distinct rather than summing. Cache fields are OPTIONAL because only
// runtimes that report caching populate them: the Claude adapter fills all five, the mock adapter
// supplies whatever a test script sets (usually nothing), and a future runtime that reports no cache
// data simply leaves them undefined — consumers coalesce with `?? 0`, so a non-reporting runtime
// contributes zero rather than breaking. There is no third runtime in-tree today.
export const ModelUsageSchema = z.object({
  provider: z.string(),
  model: z.string(),
  /** Fresh (uncached) input tokens — billed at the base input rate. */
  inputTokens: z.number().int().nonnegative(),
  /** Output (generated) tokens — the most expensive per-token rate. */
  outputTokens: z.number().int().nonnegative(),
  /** Cache READ: a previously-cached prompt prefix re-sent this turn and served from cache (~0.1× input). */
  cachedInputTokens: z.number().int().nonnegative().optional(),
  /** Cache WRITE: tokens written INTO the cache this turn, the first time a prefix is seen (~1.25× input). */
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('intent'), summary: z.string() }),
  z.object({ type: z.literal('plan-updated'), steps: z.array(z.unknown()) }),
  z.object({ type: z.literal('tool-started'), tool: z.string(), inputSummary: z.string() }),
  z.object({ type: z.literal('tool-completed'), tool: z.string(), resultSummary: z.string() }),
  z.object({
    type: z.literal('command-started'),
    commandId: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal('command-completed'),
    commandId: z.string(),
    exitCode: z.number().int(),
  }),
  z.object({ type: z.literal('file-changed'), path: z.string() }),
  z.object({ type: z.literal('finding'), finding: z.unknown() }),
  z.object({ type: z.literal('usage'), usage: ModelUsageSchema }),
  z.object({ type: z.literal('message'), text: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
