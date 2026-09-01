import { randomUUID } from 'node:crypto';
import type { SemanticEvent, TaskPhase, TaskSize } from '@awb/domain';
import type { SizingInput, SizeClassification } from '@awb/planning';
import { runIdForTask } from '@awb/database';
import { createLogger } from '@awb/telemetry';
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

/** Ordinal rank of a size, so we can tell "under-sized" (predicted smaller) from "over-sized". */
const SIZE_RANK: Record<TaskSize, number> = { S: 0, M: 1, L: 2 };

/**
 * Scores a predicted size against an expected/authoritative one for the shadow + eval corpus (TASK-62).
 * Under-sizing (predicting a SMALLER size than expected) is penalized more heavily than over-sizing:
 * an under-sized L that skips program-design/plan ships risky work, whereas an over-sized S merely
 * wastes some ceremony. `costWeight` is 0 when correct, 1 per rank of over-sizing, and 2 per rank of
 * under-sizing; an unavailable prediction counts as a max under-size miss.
 */
export function scoreSizeComparison(
  expected: TaskSize,
  predicted: TaskSize | undefined,
): { correct: boolean; underSized: boolean; costWeight: number } {
  if (predicted === undefined) {
    return { correct: false, underSized: true, costWeight: 2 * (SIZE_RANK[expected] + 1) };
  }
  const delta = SIZE_RANK[predicted] - SIZE_RANK[expected];
  if (delta === 0) return { correct: true, underSized: false, costWeight: 0 };
  const underSized = delta < 0;
  return { correct: false, underSized, costWeight: underSized ? -delta * 2 : delta };
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
  // Cost-weighted scoring against the authoritative size as the reference (TASK-62): only meaningful
  // when the authoritative call produced a size — otherwise there is nothing to compare against.
  const score = authoritative ? scoreSizeComparison(authoritative.size, local?.size) : undefined;

  const log = createLogger('awb-worker').child({
    runId: runIdForTask(input.taskId),
    taskId: input.taskId,
    phase: input.phase,
    attemptNumber: input.attemptNumber,
  });
  log.info('classifier-shadow comparison', {
    haiku,
    local: localSize,
    localModel: shadowClassifierModel(),
    agree,
    underSized: score?.underSized ?? null,
    costWeight: score?.costWeight ?? null,
  });

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
      // Cost-weighted comparison of the local (shadow) size vs the authoritative one, so the eval
      // corpus and the shadow trace collection share one scoring definition (TASK-62).
      underSized: score?.underSized ?? null,
      costWeight: score?.costWeight ?? null,
    },
  };
  try {
    await input.daemon.postEvent(event);
  } catch {
    // best-effort: a dropped shadow event must never fail the phase.
  }
}
