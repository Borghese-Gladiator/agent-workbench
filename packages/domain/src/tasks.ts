import { z } from 'zod';
import { TaskPhaseSchema, RunConditionSchema, DeliveryStateSchema } from './lifecycle.js';

export const TaskSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  prompt: z.string(),
  phase: TaskPhaseSchema,
  condition: RunConditionSchema,
  deliveryState: DeliveryStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const RunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  createdAt: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

export const PhaseAttemptSchema = z.object({
  id: z.string(),
  runId: z.string(),
  taskId: z.string(),
  phase: TaskPhaseSchema,
  attemptNumber: z.number().int().positive(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  outcome: z.string().optional(),
});
export type PhaseAttempt = z.infer<typeof PhaseAttemptSchema>;
