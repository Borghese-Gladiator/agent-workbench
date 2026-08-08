import { randomUUID } from 'node:crypto';
import type { SemanticEvent, TaskPhase } from '@awb/domain';
import type { SizingInput, SizeClassification } from '@awb/planning';
import { runIdForTask } from '@awb/database';
import type { CodingAgentAdapter } from '@awb/agent-gateway';
import type { DaemonClient } from '../daemon-client.js';
import {
  classifyWithClaude,
  classifyWithOllama,
  shadowClassifierEnabled,
  shadowClassifierModel,
} from './size-classifiers.js';

export { SIZE_CLASSIFIER_MODEL } from './size-classifiers.js';

export interface ClassifySizeInput {
  adapter: CodingAgentAdapter;
  taskId: string;
  phase: TaskPhase;
  attemptNumber: number;
  cwd: string;
  /**
   * Whether to spend a real model call for the authoritative classification (profile-driven:
   * pass `profile.usesSdkToolNames`). When false, no authoritative call is made and the result is
   * `undefined` so the contract's `size ?? 'M'` default applies — the mock runtime stays model-free.
   */
  useModel: boolean;
  /** Provider model for the authoritative (Claude) classifier. Omit to skip the call. */
  model?: string;
  input: SizingInput;
  allowedTools: string[];
  disallowedTools: string[];
  /** Daemon client for emitting the shadow-comparison semantic event; undefined on the mock path. */
  daemon?: DaemonClient;
}

/**
 * Orchestrates size classification: runs the authoritative (Claude/Haiku) classifier and,
 * when the shadow evaluator is enabled (`AWB_CLASSIFIER_SHADOW=1`), the LOCAL (Ollama) classifier in
 * parallel, then records the comparison. Both classifiers live in `size-classifiers.ts` as sibling
 * functions; this module only decides when to run each and how to report. Returns the AUTHORITATIVE
 * decision (or `undefined`); the shadow is observe-only — never changes the size, never fails the task.
 */
export async function classifyTaskSize(input: ClassifySizeInput): Promise<SizeClassification | undefined> {
  const shadow = shadowClassifierEnabled();
  const [authoritative, local] = await Promise.all([
    input.useModel && input.model
      ? classifyWithClaude(input.input, {
          adapter: input.adapter,
          taskId: input.taskId,
          cwd: input.cwd,
          model: input.model,
          allowedTools: input.allowedTools,
          disallowedTools: input.disallowedTools,
        })
      : Promise.resolve<SizeClassification | undefined>(undefined),
    shadow ? classifyWithOllama(input.input) : Promise.resolve<SizeClassification | undefined>(undefined),
  ]);

  if (shadow) {
    await recordShadowComparison(input, authoritative, local);
  }

  return authoritative;
}

/**
 * Records the Claude-vs-local comparison BOTH as a durable semantic event (queryable per-run) and a
 * daemon.log line (quick eyeballing). Best-effort — never throws.
 */
async function recordShadowComparison(
  input: ClassifySizeInput,
  authoritative: SizeClassification | undefined,
  local: SizeClassification | undefined,
): Promise<void> {
  const haiku = authoritative ? authoritative.size : 'unavailable';
  const localSize = local ? local.size : 'unavailable';
  const agree = authoritative !== undefined && local !== undefined && authoritative.size === local.size;

  console.error(
    `[classifier-shadow] task=${input.taskId} haiku=${haiku} local=${localSize} (${shadowClassifierModel()}) agree=${agree}`,
  );

  if (!input.daemon) return;
  const event: SemanticEvent = {
    id: randomUUID(),
    runId: runIdForTask(input.taskId),
    sequence: 0, // daemon assigns the authoritative per-run sequence on write
    occurredAt: new Date().toISOString(),
    phase: input.phase,
    phaseAttemptId: `${input.taskId}-${input.phase}-${input.attemptNumber}`,
    producer: 'workbench',
    type: 'status-changed',
    summary: `size classifier: haiku=${haiku} local=${localSize} agree=${agree}`,
    payloadJson: {
      kind: 'size-classifier-shadow',
      haiku: authoritative ?? null,
      local: local ?? null,
      localModel: shadowClassifierModel(),
      agree,
    },
  };
  try {
    await input.daemon.postEvent(event);
  } catch {
    // best-effort: a dropped shadow event must never fail the phase.
  }
}
