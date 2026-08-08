import { randomUUID } from 'node:crypto';
import type { SemanticEvent, TaskPhase } from '@awb/domain';
import { sizingInstruction, parseSizingOutput, type SizingInput, type SizeClassification } from '@awb/planning';
import { runIdForTask } from '@awb/database';
import type { CodingAgentAdapter } from '@awb/agent-gateway';
import type { DaemonClient } from '../daemon-client.js';
import { classifyWithOllama, shadowClassifierEnabled, shadowClassifierModel } from './ollama-classify.js';

/** The small/fast model used for the authoritative S/M/L classification (TASK-51). Cheap by design. */
export const SIZE_CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

export interface ClassifySizeInput {
  adapter: CodingAgentAdapter;
  taskId: string;
  phase: TaskPhase;
  attemptNumber: number;
  cwd: string;
  /**
   * Whether to spend a real model call to classify (TASK-38 profile-driven: pass
   * `profile.usesSdkToolNames`). When false the classifier returns `undefined` (nothing classified) so
   * the caller's contract default (`size ?? 'M'`) applies — the mock runtime stays model-free.
   */
  useModel: boolean;
  /** Provider model for the authoritative classifier session (Claude → Haiku). Omit to skip the call. */
  model?: string;
  input: SizingInput;
  allowedTools: string[];
  disallowedTools: string[];
  /** Daemon client for emitting the shadow-comparison semantic event; undefined on the mock path. */
  daemon?: DaemonClient;
}

/**
 * Classifies a task's size (TASK-51). The AUTHORITATIVE decision comes from a tiny model (Haiku) via
 * the agent adapter; it returns `undefined` when no model is available, the call fails, or the output
 * is unparseable — the classifier never invents a size, so the contract's `size ?? 'M'` default is the
 * single degradation policy.
 *
 * When the shadow evaluator is enabled (`AWB_CLASSIFIER_SHADOW=1`, TASK-61) a LOCAL model (Ollama,
 * direct HTTP — not a coding-agent adapter) classifies the same task in parallel; the two decisions
 * are recorded (semantic event + log line) for agree/diverge tracking. The shadow is observe-only:
 * it never changes the returned size and never fails the task.
 */
export async function classifyTaskSize(input: ClassifySizeInput): Promise<SizeClassification | undefined> {
  const [authoritative, shadow] = await Promise.all([
    input.useModel && input.model
      ? classifyWithClaude(input, input.model)
      : Promise.resolve<SizeClassification | undefined>(undefined),
    shadowClassifierEnabled() ? classifyWithOllama(input.input) : Promise.resolve<SizeClassification | undefined>(undefined),
  ]);

  if (shadowClassifierEnabled()) {
    await recordShadowComparison(input, authoritative, shadow);
  }

  return authoritative;
}

async function classifyWithClaude(input: ClassifySizeInput, model: string): Promise<SizeClassification | undefined> {
  try {
    const session = await input.adapter.createSession({
      role: 'planner',
      taskId: input.taskId,
      cwd: input.cwd,
      contextPayload: {},
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      model,
    });
    let text = '';
    const execution = await input.adapter.execute(
      session,
      { instruction: sizingInstruction(input.input), stopConditions: { maxTurns: 1 } },
      (event) => {
        if (event.type === 'message') text += event.text;
      },
      new AbortController().signal,
    );
    await input.adapter.dispose(session);
    // The answer usually lands in the result summary; fall back to streamed message text.
    return parseSizingOutput(execution.summary) ?? parseSizingOutput(text);
  } catch {
    return undefined;
  }
}

/**
 * Records the Haiku-vs-local comparison BOTH as a durable semantic event (queryable per-run, feeds
 * TASK-61) and a daemon.log line (quick eyeballing). Best-effort — never throws.
 */
async function recordShadowComparison(
  input: ClassifySizeInput,
  authoritative: SizeClassification | undefined,
  shadow: SizeClassification | undefined,
): Promise<void> {
  const haiku = authoritative ? authoritative.size : 'unavailable';
  const local = shadow ? shadow.size : 'unavailable';
  const agree = authoritative !== undefined && shadow !== undefined && authoritative.size === shadow.size;

  console.error(
    `[classifier-shadow] task=${input.taskId} haiku=${haiku} local=${local} (${shadowClassifierModel()}) agree=${agree}`,
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
    summary: `size classifier: haiku=${haiku} local=${local} agree=${agree}`,
    payloadJson: {
      kind: 'size-classifier-shadow',
      haiku: authoritative ?? null,
      local: shadow ?? null,
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
