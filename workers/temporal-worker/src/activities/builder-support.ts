import { runGit, getHeadSha, getStatus } from '@awb/repository';
import type { CodingAgentAdapter, AgentEventSink } from '@awb/agent-gateway';
import type { PlanSlice } from '@awb/domain';
import type { SliceAttemptOutcome } from '@awb/planning';

export interface RealBuilderAttemptInput {
  adapter: CodingAgentAdapter;
  taskId: string;
  worktreePath: string;
  slice: PlanSlice;
  allowedTools: string[];
  tokenBudget: number;
  runtimeBudgetMs: number;
  eventSink: AgentEventSink;
}

export interface RealBuilderAttemptResult {
  outcome: SliceAttemptOutcome;
  /** HEAD SHA after the attempt committed its changes; unchanged base SHA when nothing was committed. */
  headSha: string;
}

/**
 * One real builder attempt for a plan slice (Stage 2): run the Claude builder session in the
 * worktree, detect whether it produced a meaningful diff, commit the change, and report the
 * resulting HEAD SHA. The bounded retry/no-progress logic stays in @awb/planning's runSliceLoop —
 * this only executes a single attempt and reports its outcome.
 */
export async function runRealBuilderAttempt(input: RealBuilderAttemptInput): Promise<RealBuilderAttemptResult> {
  const session = await input.adapter.createSession({
    role: 'builder',
    taskId: input.taskId,
    cwd: input.worktreePath,
    contextPayload: { slice: input.slice },
    allowedTools: input.allowedTools,
  });

  try {
    const execution = await input.adapter.execute(
      session,
      {
        instruction: input.slice.objective,
        stopConditions: { maxTokens: input.tokenBudget, maxWallClockMs: input.runtimeBudgetMs },
      },
      input.eventSink,
      new AbortController().signal,
    );

    const status = await getStatus(input.worktreePath);
    if (status.length === 0) {
      // No file changes — a no-meaningful-diff attempt (drives runSliceLoop's no-progress detection).
      const headSha = await getHeadSha(input.worktreePath);
      return { outcome: { success: false, noMeaningfulDiff: true }, headSha };
    }

    await runGit(input.worktreePath, ['add', '-A']);
    await runGit(input.worktreePath, ['commit', '-m', `awb: ${input.slice.objective}`]);
    const headSha = await getHeadSha(input.worktreePath);

    // The session completing normally with a committed diff is this attempt's success signal. The
    // slice's targeted checks are run separately by the verify phase against the committed SHA.
    return {
      outcome: execution.completed
        ? { success: true }
        : {
            success: false,
            failure: {
              command: 'builder-session',
              exitCode: 1,
              failingTestIds: [],
              normalizedErrorClass: 'builder-session-incomplete',
              topRelevantStackFrame: execution.summary,
            },
          },
      headSha,
    };
  } finally {
    await input.adapter.dispose(session);
  }
}
