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
  // Emits lifecycle events (phase started/failed, retry scheduled, transport drop) — TASK-34.
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
  // Control-plane lifecycle events (TASK-34) — emitted by the 'workbench' producer, not an agent.
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

export const ModelUsageSchema = z.object({
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
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
