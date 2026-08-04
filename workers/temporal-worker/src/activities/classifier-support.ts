import type { TaskSize } from '@awb/domain';
import { classifyTaskSize, sizingInstruction, parseSizingOutput, type SizingSignals } from '@awb/planning';
import type { CodingAgentAdapter } from '@awb/agent-gateway';

/** The small/fast model used for the S/M/L size classification (TASK-51). Cheap by design. */
export const SIZE_CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

export interface ClassifySizeInput {
  adapter: CodingAgentAdapter;
  taskId: string;
  cwd: string;
  /**
   * Whether to spend a real model call to classify (TASK-38 profile-driven: pass
   * `profile.usesRealAgent`). When false the deterministic heuristic is the ONLY path, so the mock
   * runtime stays model-free and every deterministic test is unchanged.
   */
  useModel: boolean;
  /** Provider model for the classifier session (Claude → Haiku); omit to force the heuristic path. */
  model?: string;
  signals: SizingSignals;
  allowedTools: string[];
  disallowedTools: string[];
}

/**
 * Classifies a task's size (TASK-51). When `useModel` is set (a real-agent profile) it runs a
 * tiny-model session over the cheap signals and parses one S/M/L token; the deterministic heuristic
 * is the fallback whenever the model is unavailable or its output is unparseable, and it is the ONLY
 * path otherwise. Classification is advisory — it always yields a size.
 */
export async function classifyTaskSizeWithModel(input: ClassifySizeInput): Promise<TaskSize> {
  const heuristic = classifyTaskSize(input.signals);
  if (!input.useModel || !input.model) return heuristic;

  try {
    const session = await input.adapter.createSession({
      role: 'planner',
      taskId: input.taskId,
      cwd: input.cwd,
      contextPayload: {},
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      model: input.model,
    });
    let text = '';
    const execution = await input.adapter.execute(
      session,
      { instruction: sizingInstruction(input.signals), stopConditions: { maxTurns: 1 } },
      (event) => {
        if (event.type === 'message') text += event.text;
      },
      new AbortController().signal,
    );
    await input.adapter.dispose(session);
    // The classifier's answer usually lands in the result summary; fall back to streamed message text.
    return parseSizingOutput(execution.summary) ?? parseSizingOutput(text) ?? heuristic;
  } catch {
    // A classifier failure must never fail the task — fall back to the heuristic size.
    return heuristic;
  }
}
