import { runGit, getHeadSha, getStatus } from '@awb/repository';
import { runIdForTask } from '@awb/database';
import { withSpan } from '@awb/telemetry';
import type { CodingAgentAdapter, AgentEventSink } from '@awb/agent-gateway';
import type { PlanSlice, ProgramDesign, ModelUsage, Finding } from '@awb/domain';
import type { SliceAttemptOutcome } from '@awb/planning';

export interface RealBuilderAttemptInput {
  adapter: CodingAgentAdapter;
  taskId: string;
  worktreePath: string;
  slice: PlanSlice;
  /** The program-design artifact, when one was produced (L tasks), fed as builder context. */
  programDesign?: ProgramDesign;
  allowedTools: string[];
  /** Tools denied for the builder session; enforced via the adapter's `disallowedTools`. */
  disallowedTools?: string[];
  tokenBudget: number;
  runtimeBudgetMs: number;
  eventSink: AgentEventSink;
  /**
   * A prior provider session token for this slice. When set, the builder resumes that
   * transcript instead of cold-starting — a Temporal retry after a transient transport drop continues
   * rather than re-exploring from zero. Stable across attempts (keyed by slice, not attempt number).
   */
  resumeSessionId?: string;
  /**
   * Findings a prior code-fixable gate (challenge review or QA/exercise) blocked on. Rendered into
   * the builder instruction — description, path/line, and proposed remediation — so a repair attempt
   * re-implements knowing exactly what to fix, instead of re-running blind. Empty on a first attempt.
   */
  priorFindings?: Finding[];
}

export interface RealBuilderAttemptResult {
  outcome: SliceAttemptOutcome;
  /** HEAD SHA after the attempt committed its changes; unchanged base SHA when nothing was committed. */
  headSha: string;
  /** Agent usage the builder session reported, for per-phase aggregation. */
  usage?: ModelUsage;
  /** Wall-clock the builder session took, for per-phase runtime aggregation. */
  runtimeMs: number;
  /** The provider session token this attempt ran under; persist it to resume on a retry. */
  sessionId?: string;
}

/**
 * One real builder attempt for a plan slice (Stage 2): run the Claude builder session in the
 * worktree, detect whether it produced a meaningful diff, commit the change, and report the
 * resulting HEAD SHA. The bounded retry/no-progress logic stays in @awb/planning's runSliceLoop —
 * this only executes a single attempt and reports its outcome.
 */
export async function runRealBuilderAttempt(input: RealBuilderAttemptInput): Promise<RealBuilderAttemptResult> {
  // Open a `session.builder` child span under the active phase span. No explicit parent — it
  // runs inside `phase.implement`'s `withSpan` callback, so it auto-nests under that phase's trace,
  // giving the real tree `run → phase.implement → session.builder`.
  return withSpan(
    'session.builder',
    { run_id: runIdForTask(input.taskId), task_id: input.taskId, phase: 'implement' },
    () => runBuilderSession(input),
  );
}

/**
 * Render a builder instruction, appending a repair block when a prior code-fixable gate left open
 * findings. Each finding contributes its description, its `path:line` when known, and its proposed
 * remediation, so the builder re-implements against the specific defects rather than the bare
 * objective. Exported for unit testing the rendering without a live session.
 */
export function buildBuilderInstruction(objective: string, priorFindings?: Finding[]): string {
  if (!priorFindings || priorFindings.length === 0) return objective;
  const lines = priorFindings.map((f) => {
    const where = f.path ? ` (${f.path}${f.line !== undefined ? `:${f.line}` : ''})` : '';
    const fix = f.proposedRemediation ? ` — fix: ${f.proposedRemediation}` : '';
    return `- [${f.severity}] ${f.description}${where}${fix}`;
  });
  return `${objective}\n\nA prior attempt failed QA/review. Address these findings before finishing:\n${lines.join('\n')}`;
}

async function runBuilderSession(input: RealBuilderAttemptInput): Promise<RealBuilderAttemptResult> {
  const session = await input.adapter.createSession({
    role: 'builder',
    taskId: input.taskId,
    cwd: input.worktreePath,
    contextPayload: input.programDesign
      ? { slice: input.slice, programDesign: input.programDesign }
      : { slice: input.slice },
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    resumeSessionId: input.resumeSessionId,
  });

  try {
    const startedAt = Date.now();
    const instruction = buildBuilderInstruction(input.slice.objective, input.priorFindings);
    const execution = await input.adapter.execute(
      session,
      {
        instruction,
        stopConditions: { maxTokens: input.tokenBudget, maxWallClockMs: input.runtimeBudgetMs },
      },
      input.eventSink,
      new AbortController().signal,
    );
    const runtimeMs = Date.now() - startedAt;

    const status = await getStatus(input.worktreePath);
    if (status.length === 0) {
      const headSha = await getHeadSha(input.worktreePath);
      // No file changes. Distinguish two cases (a live-run finding): a session that ran to
      // completion and deliberately made no edit is a legitimate no-op slice — e.g. a
      // discovery/inventory or verify-only slice that a multi-slice plan produced — and must count
      // as success, or the implement phase blocks `repeated-failure-no-progress` on a plan that was
      // simply over-decomposed. Only an *incomplete* session with no diff is the edit/revert /
      // stuck signal `noMeaningfulDiff` is meant to catch.
      if (execution.completed) {
        return { outcome: { success: true }, headSha, usage: execution.usage, runtimeMs, sessionId: execution.sessionId };
      }
      return {
        outcome: { success: false, noMeaningfulDiff: true },
        headSha,
        usage: execution.usage,
        runtimeMs,
        sessionId: execution.sessionId,
      };
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
      usage: execution.usage,
      runtimeMs,
      sessionId: execution.sessionId,
    };
  } finally {
    await input.adapter.dispose(session);
  }
}
