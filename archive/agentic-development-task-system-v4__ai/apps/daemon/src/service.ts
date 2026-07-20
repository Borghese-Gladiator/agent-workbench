/**
 * LifecycleService: the daemon's domain orchestration layer.
 *
 * It composes the pure transition rules from @workbench/core with persistence
 * from @workbench/store and the worktree stub. HTTP handlers stay thin — they
 * parse input and call one method here. No transition logic lives in the routes
 * or in the web app.
 */

import {
  type AgentQuestionRequest,
  type AgentRunResult,
  type AgentRuntimeAdapter,
  allowedToolsForStage,
  composeExternalToolsText,
  composeSkillText,
  contextKindsForStage,
  createAgentAdapter,
  type Effort,
  envSetupPreamble,
  extractJsonBlock,
  isAgentStage,
  isGenericTitle,
  loadSkill,
  type RuntimeProfile,
  runtimeProfile,
  skillExists,
  skillForDelivery,
  skillForPlan,
  skillForReadme,
  skillForWrite,
  skillsForQa,
  skillsForReview,
  stageWantsProjectMemory,
  stripStructuredJson,
} from '@workbench/agents';
import {
  type Approval,
  ARTIFACT_KIND_LABELS,
  type ArtifactKind,
  abandonTask,
  approveDelivery,
  approveExecutionPlan,
  approveTaskBrief,
  type BounceTarget,
  closeout,
  completeDeliveryPrep,
  completeFeatureE2e,
  completeImplementation,
  completeSelfReview,
  completeStaticChecks,
  type DeliveryPolicy,
  generateTaskBrief,
  humanReviewBounce,
  humanReviewComplete,
  mockArtifactBody,
  mockArtifactTitle,
  type Project,
  rejectDelivery,
  rejectExecutionPlan,
  rejectTaskBrief,
  submitPlan,
  type Task,
  type TaskState,
  type Worktree,
} from '@workbench/core';
import { type DeliveryAdapter, GitDeliveryAdapter } from '@workbench/delivery';
import type { Store } from '@workbench/store';
import {
  CommandValidationRunner,
  isTestPath,
  KIND_LABEL,
  scopeTestCommand,
  type ValidationKind,
  type ValidationRequest,
  type ValidationResult,
} from '@workbench/validation';
import {
  branchFor,
  type GitStatus,
  StubWorktreeProvider,
  type WorktreeProvider,
  worktreePathFor,
} from '@workbench/worktree';
import { detectRepoType } from '../../../skills/_router/detect-repo-type.mjs';
import { isEmptyRepo } from '../../../skills/_router/is-empty-repo.mjs';

/**
 * The validation seam the lifecycle driver uses. `CommandValidationRunner`
 * satisfies it; tests can supply a fake. Kept narrow (one method) so it is
 * trivial to stub. `run` is async (the runner uses non-blocking `spawn`) — the
 * driver awaits it, keeping the daemon's event loop live during multi-minute
 * validation commands.
 */
export interface SyncValidationRunner {
  run(req: ValidationRequest): Promise<ValidationResult>;
}

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type AgentQuestion,
  type AgentQuestionAnswer,
  type AgentRun,
  type AgentRunEvent,
  type AgentRuntime,
  isAutoAdvanceable,
  isTerminalAgentRunStatus,
  type RuntimeConfig,
  STAGES,
  type Stage,
  validateAnswer,
} from '@workbench/core';
import { AgentRunExecutor } from './agent-run-executor.js';
import { logger } from './logger.js';
import { REPO_ROOT } from './paths.js';

/**
 * Builds the agent adapter for a project's runtime + per-project config.
 * Injectable so the daemon can substitute a pre-built adapter (its Claude
 * adapter carries an MCP-server reader) and tests can supply fakes.
 */
export type AgentFactory = (runtime: AgentRuntime, config: RuntimeConfig) => AgentRuntimeAdapter;

const defaultAgentFactory: AgentFactory = (runtime, config) => createAgentAdapter(runtime, config);

export class LifecycleService {
  private readonly worktrees: WorktreeProvider;
  /** No-op provider for 'mock' projects, whose repoPath may be a placeholder. */
  private readonly stubWorktrees: WorktreeProvider = new StubWorktreeProvider();
  private readonly worktreesDir: string;
  private readonly agentFor: AgentFactory;
  private readonly validation: SyncValidationRunner;
  private readonly delivery: DeliveryAdapter;
  private readonly runExecutor: AgentRunExecutor;
  /** The repo this daemon runs from — a project at this path is self-targeting. */
  private readonly repoRoot: string;

  constructor(
    private readonly store: Store,
    worktrees: WorktreeProvider = new StubWorktreeProvider(),
    worktreesDir: string = join(tmpdir(), 'workbench-worktrees'),
    agentFor: AgentFactory = defaultAgentFactory,
    /** Base URL the spawned MCP gate relays back to (real-CLI runs only). */
    daemonUrl?: string,
    /** Runs a project's test/lint/typecheck commands in the task worktree. */
    validation: SyncValidationRunner = new CommandValidationRunner(),
    /** Commits/pushes the branch and squash-merges or opens a draft PR. */
    delivery: DeliveryAdapter = new GitDeliveryAdapter({ dryRun: false }),
    /** The daemon's own repo root; overridable so tests can simulate self-targeting. */
    repoRoot: string = REPO_ROOT,
  ) {
    this.worktrees = worktrees;
    this.worktreesDir = worktreesDir;
    this.agentFor = agentFor;
    this.validation = validation;
    this.delivery = delivery;
    this.runExecutor = new AgentRunExecutor(store, daemonUrl);
    this.repoRoot = repoRoot;
  }

  /**
   * A project is self-targeting when its repoPath is the very checkout this
   * daemon runs from. Such a project must never run in direct (skip-worktree)
   * mode: committing in place would let an agent edit the code/DB driving the
   * run. The skip-worktree path is refused for it (here and in the API).
   */
  isSelfTargeting(repoPath: string | undefined): boolean {
    return !!repoPath && resolve(repoPath) === resolve(this.repoRoot);
  }

  private stateOf(taskId: string): { task: Task; state: TaskState } {
    const task = this.store.getTask(taskId);
    if (!task) throw new HttpError(404, `Task not found: ${taskId}`);
    return { task, state: { stage: task.stage, status: task.status } };
  }

  /**
   * Picks the worktree provider for a task's project. 'mock' projects use the
   * stub (no git, no FS) so the lifecycle can be exercised against a placeholder
   * repoPath; everything else uses the real git provider.
   */
  private worktreesFor(taskId: string): WorktreeProvider {
    const task = this.store.getTask(taskId);
    const runtime = task ? this.runtimeFor(task) : 'mock';
    // Runtimes that don't operate in a real checkout (mock) use the stub provider.
    return runtimeProfile(runtime).usesRealWorktree ? this.worktrees : this.stubWorktrees;
  }

  /** The agent runtime configured for a task's project (defaults to 'mock'). */
  private runtimeFor(task: Task): AgentRuntime {
    return this.store.getProject(task.projectId)?.agentRuntime ?? 'mock';
  }

  /** The runtime profile for a task's project — the daemon's one runtime-behavior seam. */
  private profileFor(task: Task): RuntimeProfile {
    return runtimeProfile(this.runtimeFor(task));
  }

  /** The adapter for a task's project runtime + config. */
  private adapterFor(task: Task): AgentRuntimeAdapter {
    const project = this.store.getProject(task.projectId);
    return this.agentFor(project?.agentRuntime ?? 'mock', project?.runtimeConfig ?? {});
  }

  /**
   * Whether a project runs a REAL agent (any runtime that operates in a real
   * checkout). The mock runtime returns canned content and drives the no-op
   * lifecycle paths; real runtimes spawn their CLI in the task worktree.
   */
  private runsRealAgent(task: Task): boolean {
    return this.profileFor(task).usesRealWorktree;
  }

  /**
   * Per-stage model + effort for a task, resolved through its runtime profile
   * (and the project's runtime config). Replaces the old global Claude-vocabulary
   * `modelForStage`/`effortForStage` so model routing is runtime-specific.
   */
  private modelEffortFor(task: Task, stage: string): { model?: string; effort?: Effort } {
    const project = this.store.getProject(task.projectId);
    const profile = runtimeProfile(project?.agentRuntime ?? 'mock');
    return {
      model: profile.modelForStage(stage, project?.runtimeConfig ?? {}),
      effort: profile.effortForStage(stage),
    };
  }

  /** Create a mock artifact for a kind, attributed to the task's current stage run. */
  private addMockArtifact(
    task: Task,
    kind: ArtifactKind,
    extra?: { rejectionFeedback?: string },
  ): void {
    this.store.createArtifact({
      taskId: task.id,
      kind,
      title: mockArtifactTitle(kind),
      body: mockArtifactBody(kind, {
        taskTitle: task.title,
        rawRequest: task.rawRequest,
        ...extra,
      }),
    });
  }

  /**
   * Produce a stage's deliverable artifact, runtime-aware.
   *
   * For a `claude` project running a real agent stage, this invokes the agent
   * adapter and persists its REAL output (plus the run transcript). Every other
   * case — `mock` projects, or orchestration kinds the agent has no instruction
   * for (`baseline_evidence`, `delivery_package`, `bounce_packet`) — falls back
   * to the deterministic mock body.
   *
   * This is the seam that was missing: the lifecycle transitions used to ALWAYS
   * write mock content, so `(mock)` template prose leaked into real artifacts
   * regardless of the project's runtime.
   */
  private async produceStageArtifact(
    task: Task,
    kind: ArtifactKind,
    stage: string,
    extra?: {
      rejectionFeedback?: string;
      resume?: { sessionId: string; message: string };
      deriveTitle?: boolean;
    },
  ): Promise<void> {
    const project = this.store.getProject(task.projectId);
    // Real-runnable = the mock-runnable read-only stages PLUS `delivery_prep`, which
    // is not in AGENT_STAGES (it has no mock equivalent worth faking) but DOES run a
    // real agent via the `pr-description` skill. `claudeStagePrompt` resolves its
    // instruction from NON_MOCK_STAGE_INSTRUCTIONS, like `implementation`.
    const runReal = this.runsRealAgent(task) && (isAgentStage(stage) || stage === 'delivery_prep');
    if (!runReal) {
      // No real session to resume on the mock path — fold the resume message
      // into the threaded rejection feedback so the mock still reflects it.
      const rejectionFeedback = extra?.resume?.message ?? extra?.rejectionFeedback;
      this.addMockArtifact(task, kind, { rejectionFeedback });
      return;
    }

    const wt = this.store.getActiveWorktree(task.id);
    // The brief runs at intake, before the task worktree exists. A read-only
    // stage can safely read the project's checkout; fall back to it so the
    // agent (which refuses to run without a cwd) is grounded in the real repo.
    const worktreePath = wt?.worktreePath ?? project?.repoPath;
    const repoPath = worktreePath;
    const adapter = this.adapterFor(task);

    // Route through the run executor so the lifecycle run is a first-class
    // AgentRun: events stream over SSE (the UI's live terminal) and persist for
    // replay. The executor calls `persistResult` on success AND failure (the
    // failure case persists the transcript only), so nothing is written here.
    const outcome = await this.runExecutor.run({
      taskId: task.id,
      stage: stage as Stage,
      adapter,
      worktreePath,
      contextArtifactIds: this.store.listArtifacts(task.id).map((a) => a.id),
      contextArtifacts: this.resolveStageContext(task.id, stage),
      projectMemory: this.resolveProjectMemory(task.projectId, stage),
      allowedTools: allowedToolsForStage(stage),
      ...this.modelEffortFor(task, stage),
      taskTitle: task.title,
      rawRequest: task.rawRequest,
      deriveTitle: extra?.deriveTitle,
      skillText: this.skillTextForStage(stage, repoPath, project),
      repoProfile: this.repoProfileFor(repoPath),
      // Thread the reviewer's rejection feedback into the prompt so the model
      // actually sees why the previous attempt was sent back. Skipped when
      // resuming: the comment is sent as the session's next turn (see `resume`),
      // not appended to a fresh stage packet.
      reviewerFeedback: extra?.resume
        ? undefined
        : (extra?.rejectionFeedback ?? this.reviewerFeedbackForStage(task.id, stage)),
      // Resume the prior session and send ONLY the reviewer's comment.
      resume: extra?.resume,
      persistResult: ({ transcript, produced }) => {
        const stageRunId = this.store.stageRunForStage(task.id, stage)?.id ?? null;
        this.store.createArtifact({
          taskId: task.id,
          stageRunId,
          kind: transcript.kind as ArtifactKind,
          title: transcript.title,
          body: transcript.body,
        });
        for (const p of produced) {
          this.store.createArtifact({
            taskId: task.id,
            stageRunId,
            kind: p.kind as ArtifactKind,
            title: p.title,
            body: p.body,
          });
        }
      },
    });

    // A failed real run leaves no deliverable. Surface it rather than silently
    // advancing on an empty stage — the caller's transition would otherwise move
    // forward with nothing produced.
    if (outcome.status !== 'succeeded') {
      throw new HttpError(
        502,
        `agent run for stage "${stage}" failed: ${outcome.error ?? 'unknown'}`,
      );
    }
  }

  /**
   * Comment from the most recent matching gate decision (rejection/bounce), if
   * any. This is the reviewer feedback that must be threaded into the redo so it
   * actually reaches the generator/agent — the seam where it was being dropped.
   */
  private lastGateRejection(
    taskId: string,
    gate: Approval['gate'],
    decisions: Approval['decision'][],
  ): string | undefined {
    const matching = this.store
      .listApprovals(taskId)
      .filter((a) => a.gate === gate && decisions.includes(a.decision));
    const comment = matching.length ? matching[matching.length - 1]!.comment : null;
    return comment?.trim() ? comment : undefined;
  }

  /**
   * Comment from the most recent decision among several (gate, decision) pairs,
   * ordered by when the decision was made. Used when more than one gate can send
   * a stage back: the plan stage is re-entered by a plan REJECTION (execution_plan
   * gate) AND by a human-review BOUNCE-to-plan (human_review gate); the redo must
   * pick up whichever one actually re-entered the stage, i.e. the latest.
   */
  private latestGateComment(
    taskId: string,
    pairs: { gate: Approval['gate']; decision: Approval['decision'] }[],
  ): string | undefined {
    const matching = this.store
      .listApprovals(taskId)
      .filter((a) => pairs.some((p) => p.gate === a.gate && p.decision === a.decision));
    // listApprovals is ordered by decidedAt, so the last match is the most recent.
    const comment = matching.length ? matching[matching.length - 1]!.comment : null;
    return comment?.trim() ? comment : undefined;
  }

  /**
   * Reviewer feedback to hand the agent for the stage it's about to run, sourced
   * from the gate(s) that send that stage back. Stages without a feedback gate get
   * nothing.
   */
  private reviewerFeedbackForStage(taskId: string, stage: string): string | undefined {
    switch (stage) {
      case 'task_brief':
        return this.lastGateRejection(taskId, 'task_brief', ['rejected']);
      case 'discovery':
        // Re-entered by a plan rejection OR a human-review bounce-to-plan.
        return this.latestGateComment(taskId, [
          { gate: 'execution_plan', decision: 'rejected' },
          { gate: 'human_review', decision: 'bounce' },
        ]);
      case 'implementation':
        return this.lastGateRejection(taskId, 'human_review', ['bounce']);
      default:
        return undefined;
    }
  }

  /**
   * Resolve the FULL bodies of the prior artifacts a stage consumes, so the
   * agent reads what upstream stages already wrote instead of re-deriving it
   * (the turn-explosion fix). The kinds-per-stage allowlist lives in the agents
   * package (`contextKindsForStage`); this method does the disk IO the adapter
   * is forbidden from doing. Picks the LATEST artifact per kind (artifacts are
   * ordered by createdAt asc, so the last match wins) and skips any whose body
   * can't be read. Returns `undefined` when the stage wants no context, so the
   * prompt omits the section entirely.
   */
  private resolveStageContext(
    taskId: string,
    stage: string,
  ): { kind: ArtifactKind; title: string; body: string }[] | undefined {
    const kinds = contextKindsForStage(stage);
    if (kinds.length === 0) return undefined;
    const artifacts = this.store.listArtifacts(taskId); // createdAt asc
    const resolved: { kind: ArtifactKind; title: string; body: string }[] = [];
    for (const kind of kinds) {
      const latest = artifacts.filter((a) => a.kind === kind).at(-1);
      if (!latest) continue;
      const body = this.store.readArtifactBody(latest.id);
      if (body == null) continue;
      resolved.push({ kind, title: latest.title, body });
    }
    return resolved.length ? resolved : undefined;
  }

  /**
   * The project's distilled memory log, but ONLY for the stages that consume it
   * ({@link stageWantsProjectMemory} — discovery + planning) and ONLY when it's
   * non-empty. Returns undefined otherwise so the prompt omits the section.
   */
  private resolveProjectMemory(projectId: string, stage: string): string | undefined {
    if (!stageWantsProjectMemory(stage)) return undefined;
    const memory = this.store.readProjectMemory(projectId).trim();
    return memory ? memory : undefined;
  }

  /* ---------- Intake -> Brief ---------- */
  async generateBrief(taskId: string): Promise<Task> {
    const { task, state } = this.stateOf(taskId);
    // Record the raw prompt once, on first brief generation. The raw prompt is
    // a verbatim capture of the request, not a model deliverable — it stays a
    // straight echo regardless of runtime.
    if (!this.store.listArtifacts(taskId).some((a) => a.kind === 'raw_prompt')) {
      this.addMockArtifact(task, 'raw_prompt');
    }
    // When the title is a placeholder (e.g. the request was just a Linear URL),
    // ask the brief agent to derive a real one and emit it in its json block.
    const deriveTitle = isGenericTitle(task.title);
    // On regeneration after a rejection, thread the reviewer's comment into the
    // new brief so the feedback actually reaches the generator/agent.
    await this.produceStageArtifact(task, 'task_brief', 'task_brief', {
      rejectionFeedback: this.lastGateRejection(taskId, 'task_brief', ['rejected']),
      deriveTitle,
    });
    // Rename the task to the title the agent derived, BEFORE the worktree/branch
    // exist (those are created at brief approval), so naming reflects the real
    // request rather than the placeholder. Only when we asked AND the title is
    // still generic — a real title the human already typed is never overwritten.
    if (deriveTitle) this.applyDerivedTitle(taskId);
    return this.transition(taskId, generateTaskBrief(state));
  }

  /**
   * Read the `title` the brief agent put in its json block and rename the task to
   * it, when present and non-generic. No-op if the brief carried no usable title
   * (mock runtime, or the agent omitted it) — the placeholder simply stands.
   */
  private applyDerivedTitle(taskId: string): void {
    const brief = this.store
      .listArtifacts(taskId)
      .filter((a) => a.kind === 'task_brief')
      .at(-1);
    if (!brief) return;
    const body = this.store.readArtifactBody(brief.id);
    if (!body) return;
    const json = extractJsonBlock(body);
    const derived =
      json && typeof json === 'object' && typeof (json as { title?: unknown }).title === 'string'
        ? (json as { title: string }).title.trim()
        : '';
    if (derived && !isGenericTitle(derived)) this.store.setTaskTitle(taskId, derived);
  }

  async approveBrief(
    taskId: string,
    comment?: string,
    opts: { skipWorktree?: boolean } = {},
  ): Promise<Task> {
    const { task, state } = this.stateOf(taskId);
    this.requireNoUnansweredQuestions(taskId);
    const result = approveTaskBrief(state);
    this.store.recordApproval({ taskId, gate: 'task_brief', decision: 'approved', comment });
    // Backstop: a self-targeting project (repoPath == the daemon's own repo) can
    // NEVER take the direct path, even if a caller bypasses the HTTP layer and
    // passes skipWorktree. The API rejects this loudly; here we just refuse to
    // honor it so an isolated worktree is always created.
    const project = this.store.getProject(task.projectId);
    const skipWorktree = opts.skipWorktree && !this.isSelfTargeting(project?.repoPath);
    // Approving the brief advances to discovery and creates the task's real
    // git worktree + branch (one per task), UNLESS the caller has chosen the
    // direct-commit path (skipWorktree). In that case no worktree is created
    // and all downstream cwd (implementation/validation/delivery) resolves to
    // project.repoPath on the defaultBranch.
    const updated = this.transition(taskId, result);
    if (skipWorktree) {
      // Persist the choice so downstream cwd resolution knows to use repoPath.
      this.store.setWorktreeModeOnTask(updated.id, 'direct');
    } else if (!this.store.getActiveWorktree(updated.id)) {
      await this.createWorktree(updated.id);
    }
    // Auto-advance: discovery -> baseline -> plan submission, parking at the
    // human plan gate.
    return this.advanceUntilGate(updated.id);
  }

  /**
   * Reject the brief and immediately produce a revised one, parking back at the
   * Human Brief Approval gate — one motion, no manual "Regenerate" step.
   *
   * Preferred path (claude project whose brief captured a session id): RESUME
   * that session and send ONLY the reviewer's comment, so the model revises the
   * brief it already wrote in-context instead of re-prompting from scratch.
   *
   * Fallback (no session — mock runtime, a legacy brief, OR a resume that failed
   * because the session aged out of the CLI's store): a fresh full-context
   * generation with the comment threaded in as reviewer feedback, EMPHASIZED so
   * the redo still centers on what the human sent back.
   */
  async rejectBrief(taskId: string, comment?: string): Promise<Task> {
    const { task, state } = this.stateOf(taskId);
    this.store.recordApproval({ taskId, gate: 'task_brief', decision: 'rejected', comment });
    // Step back to the brief-writing stage (the legal reject transition)...
    const reverted = this.transition(taskId, rejectTaskBrief(state));
    // ...regenerate the brief by RESUMING the brief's own session and sending only
    // the reviewer's comment, so the model revises in-context rather than
    // re-prompting from scratch.
    await this.produceStageArtifactResuming(task, 'task_brief', 'task_brief', comment);
    // ...and return to the approval gate with the revised brief.
    return this.transition(
      taskId,
      generateTaskBrief({ stage: reverted.stage, status: reverted.status }),
    );
  }

  /**
   * Produce a stage's deliverable by RESUMING the stage's prior agent session and
   * sending ONLY the reviewer's comment as the next turn — the in-context redo. So
   * a rejection/bounce continues the conversation that already wrote the artifact
   * (it holds the full context: the plan, the code, its own reasoning) and edits it
   * incrementally, instead of cold-starting a fresh session that re-derives
   * everything and writes a brand-new artifact set.
   *
   * Falls back to a single FRESH full-context run (comment emphasized) only when
   * there is no session to resume (mock runtime, a legacy artifact) OR the resume
   * fails because the session aged out of the CLI's store. The fallback is the
   * exception, not the default — the default is resume.
   */
  private async produceStageArtifactResuming(
    task: Task,
    kind: ArtifactKind,
    stage: string,
    comment?: string,
  ): Promise<void> {
    const trimmed = comment?.trim() || undefined;
    const sessionId = this.store.latestSessionForStage(task.id, stage as Stage);
    const resume = sessionId && trimmed ? { sessionId, message: trimmed } : undefined;
    try {
      await this.produceStageArtifact(task, kind, stage, {
        resume,
        // Fallback within produceStageArtifact (mock runtime) still gets the comment.
        rejectionFeedback: trimmed,
      });
    } catch (err) {
      // A resume that failed (e.g. the session aged out) leaves no artifact. Don't
      // surface the error — start a FRESH session with the full stage context and
      // the reviewer's comment emphasized, so the human still gets a redo.
      if (!resume) throw err;
      await this.produceStageArtifact(task, kind, stage, {
        rejectionFeedback: emphasizeFeedback(trimmed!),
      });
    }
  }

  /* ---------- Worktree management ---------- */

  /**
   * Create the one branch + one git worktree for a task. Enforces a single
   * active worktree per task and never mutates the project's main checkout.
   */
  async createWorktree(taskId: string): Promise<Worktree> {
    const task = this.store.getTask(taskId);
    if (!task) throw new HttpError(404, `Task not found: ${taskId}`);
    if (this.store.getActiveWorktree(taskId)) {
      throw new HttpError(409, 'task already has an active worktree');
    }
    const project = this.store.getProject(task.projectId);
    if (!project) throw new HttpError(404, 'project not found');

    const branch = branchFor(task.id, task.title);
    const worktreePath = worktreePathFor(project.repoPath, task.id, task.title);

    const handle = await this.worktreesFor(task.id).create({
      taskId: task.id,
      repoPath: project.repoPath,
      defaultBranch: project.defaultBranch,
      branch,
      worktreePath,
    });
    const wt = this.store.createWorktree({
      taskId: task.id,
      worktreePath: handle.worktreePath,
      branch: handle.branch,
      baseBranch: handle.baseBranch,
      status: handle.status,
    });
    this.store.setWorktreeOnTask(task.id, wt.id);
    return wt;
  }

  async refreshGitStatus(taskId: string): Promise<GitStatus> {
    const wt = this.requireActiveWorktree(taskId);
    return this.worktreesFor(taskId).status(wt.worktreePath);
  }

  async worktreeDiff(taskId: string): Promise<string> {
    const wt = this.requireActiveWorktree(taskId);
    return this.worktreesFor(taskId).diff(wt.worktreePath);
  }

  /**
   * Repo-relative paths of the TEST files this task changed, used to scope the
   * validation/baseline test run to the change instead of the whole repo. Reads
   * the worktree's git status; returns `[]` when there's no worktree or no
   * changed test files (callers then leave the test command unscoped).
   */
  private async changedTestPaths(taskId: string): Promise<string[]> {
    const wt = this.store.getActiveWorktree(taskId);
    if (!wt || !existsSync(wt.worktreePath)) return [];
    try {
      const status = await this.worktreesFor(taskId).status(wt.worktreePath);
      return status.changedFiles.map((f) => f.path).filter((p) => isTestPath(p));
    } catch {
      return [];
    }
  }

  /** Remove the worktree from disk and mark it abandoned. */
  async abandonWorktree(taskId: string): Promise<Worktree> {
    const wt = this.requireActiveWorktree(taskId);
    await this.worktreesFor(taskId).remove(wt.worktreePath, { force: true, branch: wt.branch });
    this.store.updateWorktreeStatus(wt.id, 'abandoned');
    return this.store.getWorktreeById(wt.id)!;
  }

  /** Keep the worktree on disk but mark it preserved (no further auto-cleanup). */
  preserveWorktree(taskId: string): Worktree {
    const wt = this.requireActiveWorktree(taskId);
    this.store.updateWorktreeStatus(wt.id, 'preserved');
    return this.store.getWorktreeById(wt.id)!;
  }

  /**
   * Delete a task entirely. Removes any active worktree from disk first (so we
   * don't orphan a checkout), then deletes the task and all child rows.
   */
  async deleteTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new HttpError(404, `Task not found: ${taskId}`);
    const wt = this.store.getActiveWorktree(taskId);
    if (wt) {
      await this.worktreesFor(taskId).remove(wt.worktreePath, { force: true, branch: wt.branch });
    }
    this.store.deleteTask(taskId);
  }

  private requireActiveWorktree(taskId: string): Worktree {
    const wt = this.store.getActiveWorktree(taskId);
    if (!wt) throw new HttpError(404, 'no active worktree for task');
    return wt;
  }

  /* ---------- Agent runs ---------- */

  /**
   * Compose the `## Skill` block to inject for a stage, or `undefined` for stages
   * without skills. The gated CLI path can't auto-discover `.claude/skills/`, so we
   * detect the repo profile and inline the routed skill bodies (see skills.ts).
   *
   * - `discovery`: the repo's test-first planning skill (if authored).
   * - `implementation`: the repo's code-writing skill (if authored).
   * - `agent_self_review`: profile review (if recognized) + always-on adversarial.
   * - `feature_e2e`: the E2E driver + the artifact bundler.
   *
   * Never throws on an unknown repo — review still runs adversarial-only, and a repo
   * without a planning skill just plans without one.
   */
  /**
   * Join an env-setup preamble with a skill body for a stage, dropping empty
   * parts. Returns undefined when both are empty (no skillText for the stage),
   * matching the rest of `skillTextForStage`'s contract.
   */
  private joinSkillSections(...parts: (string | undefined)[]): string | undefined {
    const kept = parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p));
    return kept.length ? kept.join('\n\n') : undefined;
  }

  private skillTextForStage(
    stage: string,
    repoPath?: string,
    project?: Project | null,
  ): string | undefined {
    return this.joinSkillSections(
      this.baseSkillTextForStage(stage, repoPath, project?.deliveryPolicy),
      this.externalToolsTextFor(stage, project),
    );
  }

  /**
   * The `## External tool: …` sections for a stage, from the project's configured
   * external helpers (e.g. `klaviyo-local-seed` on the enterprise `app` project).
   * The doc tier comes from the project's runtime profile: full-doc runtimes get
   * the tool's complete agent doc, small-local-model runtimes get only the
   * per-stage recipe card — the tools stay usable on ANY runtime.
   */
  private externalToolsTextFor(stage: string, project?: Project | null): string | undefined {
    const tools = project?.externalTools ?? [];
    if (tools.length === 0) return undefined;
    const tier = runtimeProfile(project?.agentRuntime ?? 'mock').toolDocTier;
    return composeExternalToolsText(tools, stage, tier);
  }

  private baseSkillTextForStage(
    stage: string,
    repoPath?: string,
    deliveryPolicy?: DeliveryPolicy,
  ): string | undefined {
    if (stage === 'discovery') {
      const profile = repoPath ? detectRepoType(repoPath) : null;
      const planSkill = skillForPlan(profile);
      // Only inject when authored — an unknown profile or unauthored skill plans
      // without one rather than failing.
      if (planSkill && skillExists(planSkill)) return composeSkillText([planSkill]);
      return undefined;
    }
    if (stage === 'implementation') {
      const profile = repoPath ? detectRepoType(repoPath) : null;
      const writeSkill = skillForWrite(profile);
      // Enterprise repos run shell commands (tests) against a worktree whose dev
      // environment isn't set up in a non-interactive shell — tell the agent how to
      // load it before any test/lint/build. Prepended ahead of the write skill.
      const env = envSetupPreamble(profile);
      // Only inject when authored — an unknown profile or unauthored skill implements
      // without one rather than failing. Inject the raw body (not composeSkillText):
      // its dispatch preamble instructs Task-subagent fan-out, which is wrong for
      // the single-agent coding stage.
      const body = writeSkill && skillExists(writeSkill) ? loadSkill(writeSkill) : undefined;
      // A brand-new/EMPTY repo gets the README skill appended as a SUFFIX — it runs
      // LAST, after the agent has written the code, so it documents commands/files that
      // now actually exist (not plan guesses). Profile-agnostic, and gated PROGRAMMATICALLY
      // on `isEmptyRepo` only: an existing repo is never touched, so the agent never has
      // to guess whether a README should be created or updated.
      const readme = repoPath && isEmptyRepo(repoPath) ? loadSkill(skillForReadme()) : undefined;
      return this.joinSkillSections(env, body, readme);
    }
    if (stage === 'agent_self_review') {
      const profile = repoPath ? detectRepoType(repoPath) : null;
      const { profile: profileSkill, always } = skillsForReview(profile);
      // Include the profile skill only if its file actually exists. `fender`/`app`
      // are mapped but unauthored; a missing one must NOT sink the review — we fall
      // back to the always-on adversarial pass.
      const profileNames = profileSkill && skillExists(profileSkill) ? [profileSkill] : [];
      return composeSkillText([...profileNames, ...always]);
    }
    if (stage === 'feature_e2e') {
      const profile = repoPath ? detectRepoType(repoPath) : null;
      // Same worktree-env caveat as implementation: the QA stage runs the project's
      // E2E harness, so load the repo env first on enterprise repos.
      return this.joinSkillSections(
        envSetupPreamble(profile),
        composeSkillText([...skillsForQa()]),
      );
    }
    if (stage === 'delivery_prep') {
      // Profile-agnostic: every repo gets a good PR description / commit summary.
      // Name the active delivery policy ahead of the skill body so the writer picks
      // the right framing (PR description vs squash-commit summary) — the skill keys
      // off this line. Default to create_pr when the policy is unknown.
      const policy: DeliveryPolicy = deliveryPolicy ?? 'create_pr';
      const policyNote = `Active delivery policy: \`${policy}\`.`;
      return `${policyNote}\n\n${loadSkill(skillForDelivery())}`;
    }
    return undefined;
  }

  /** The repo profile for compliance verification (same detector the skills use). */
  private repoProfileFor(repoPath?: string): string | undefined {
    return (repoPath ? detectRepoType(repoPath) : null) ?? undefined;
  }

  getAgentRun(runId: string): AgentRun {
    const run = this.store.getAgentRun(runId);
    if (!run) throw new HttpError(404, `Agent run not found: ${runId}`);
    return run;
  }

  listAgentRuns(taskId: string): AgentRun[] {
    return this.store.listAgentRuns(taskId);
  }

  /**
   * The task's current in-flight run, or null. `awaiting_input` counts — a run
   * paused on a question is still the current stage's run (the UI terminal
   * stays attached to it).
   */
  activeAgentRun(taskId: string): AgentRun | null {
    if (!this.store.getTask(taskId)) throw new HttpError(404, `Task not found: ${taskId}`);
    const runs = this.store
      .listAgentRuns(taskId)
      .filter((r) => r.status === 'running' || r.status === 'awaiting_input');
    return runs.length ? runs[runs.length - 1]! : null;
  }

  agentRunEvents(runId: string, afterSeq = 0): AgentRunEvent[] {
    return this.store.listAgentRunEvents(runId, afterSeq);
  }

  /** Subscribe to a run's live events (for SSE). Returns an unsubscribe fn. */
  subscribeToRun(runId: string, sub: (event: AgentRunEvent) => void): () => void {
    return this.runExecutor.subscribe(runId, sub);
  }

  /**
   * Subscribe to a single task's state changes (for SSE). The store emits on
   * every transition / new artifact; we filter the firehose to one task. The
   * callback takes no payload — it signals "refetch this task". Returns an
   * unsubscribe fn.
   */
  subscribeToTask(taskId: string, sub: () => void): () => void {
    return this.store.onTaskChange((changedId) => {
      if (changedId === taskId) sub();
    });
  }

  /**
   * Start a background streaming run on this service's executor and return the
   * AgentRun immediately (events stream over SSE). NOT a production lifecycle
   * entry — the auto-advance driver runs agent stages directly (and awaits
   * them). This exists so SSE / run-infrastructure tests can launch a run on the
   * same executor the SSE endpoints read from, now that the manual-trigger routes
   * are gone. Persists the transcript + produced artifacts, attributed to the
   * stage's run; does not advance the lifecycle.
   */
  startBackgroundRun(taskId: string, stage: Stage): AgentRun {
    const task = this.store.getTask(taskId);
    if (!task) throw new HttpError(404, `Task not found: ${taskId}`);
    const project = this.store.getProject(task.projectId);
    const wt = this.store.getActiveWorktree(taskId);
    const repoPath = project?.repoPath ?? wt?.worktreePath;
    const stageRunId = this.store.stageRunForStage(taskId, stage)?.id ?? null;
    return this.runExecutor.start({
      taskId,
      stage,
      adapter: this.agentFor(project?.agentRuntime ?? 'mock', project?.runtimeConfig ?? {}),
      worktreePath: wt?.worktreePath,
      contextArtifactIds: this.store.listArtifacts(taskId).map((a) => a.id),
      contextArtifacts: this.resolveStageContext(taskId, stage),
      projectMemory: this.resolveProjectMemory(task.projectId, stage),
      allowedTools: allowedToolsForStage(stage),
      ...this.modelEffortFor(task, stage),
      taskTitle: task.title,
      rawRequest: task.rawRequest,
      skillText: this.skillTextForStage(stage, repoPath, project),
      repoProfile: this.repoProfileFor(repoPath),
      reviewerFeedback: this.reviewerFeedbackForStage(taskId, stage),
      persistResult: ({ transcript, produced }) => {
        this.store.createArtifact({
          taskId,
          stageRunId,
          kind: transcript.kind as ArtifactKind,
          title: transcript.title,
          body: transcript.body,
        });
        for (const p of produced) {
          this.store.createArtifact({
            taskId,
            stageRunId,
            kind: p.kind as ArtifactKind,
            title: p.title,
            body: p.body,
          });
        }
      },
    });
  }

  /* ---------- Mid-run questions (the interactive gate) ---------- */

  /**
   * Raise a question for a run and block until the human answers. Used by the
   * internal MCP relay endpoint the spawned `workbench_ask` server calls.
   */
  askQuestion(runId: string, question: AgentQuestionRequest): Promise<AgentQuestionAnswer> {
    const run = this.store.getAgentRun(runId);
    if (!run) throw new HttpError(404, `Agent run not found: ${runId}`);
    return this.runExecutor.gate.ask(runId, run.taskId, question);
  }

  /** Record a human answer to a question; resumes the paused run. */
  answerQuestion(questionId: string, answer: AgentQuestionAnswer): AgentQuestion {
    const question = this.store.getAgentQuestion(questionId);
    if (!question) throw new HttpError(404, `Question not found: ${questionId}`);
    if (question.answer) throw new HttpError(409, 'question already answered');
    const err = validateAnswer(question, answer);
    if (err) throw new HttpError(400, err);
    const updated = this.runExecutor.answer(questionId, answer);
    if (!updated) throw new HttpError(409, 'question could not be answered');
    return updated;
  }

  /**
   * Stop an in-flight agent run — kills its spawned CLI subprocess and records
   * the run `failed`. 404 if unknown; 409 if already terminal. Returns the
   * refreshed run.
   *
   * The executor's abort makes `execute` persist the run `failed` once the
   * process tears down. If the run has no live aborter (a race, or an orphan the
   * boot sweep missed), fall back to marking it failed directly so the UI never
   * hangs on a zombie `running`.
   */
  stopAgentRun(runId: string): AgentRun {
    const run = this.getAgentRun(runId);
    if (isTerminalAgentRunStatus(run.status)) {
      throw new HttpError(409, `Agent run already ${run.status}`);
    }
    if (!this.runExecutor.stop(runId)) {
      // No live process to kill — backstop the record so the run isn't stuck.
      this.store.updateAgentRun(runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: 'stopped by operator',
      });
    }
    return this.getAgentRun(runId);
  }

  /**
   * Abandon a task — terminal `abandoned` status, reachable from ANY non-terminal
   * stage (the single operator escape hatch). Stops any in-flight run first so an
   * abandoned task leaves no live agent behind. 409 if the task is already
   * terminal (the `abandonTask` transition refuses it).
   */
  abandonTask(taskId: string, comment?: string): Task {
    const { state } = this.stateOf(taskId);
    // Validate the transition BEFORE touching the running agent: abandonTask
    // throws on an already-terminal task, and we must not kill a process for an
    // abandon that's going to 409 anyway.
    const result = abandonTask(state);
    const active = this.activeAgentRun(taskId);
    if (active) this.stopAgentRun(active.id);
    // The abandon reason is recorded as the StageRun note (audit trail); no
    // approval row — abandon is not a gate decision.
    const note = comment?.trim() ? `task abandoned: ${comment.trim()}` : result.note;
    return this.transition(taskId, { ...result, note });
  }

  listUnansweredQuestions(taskId: string): AgentQuestion[] {
    return this.store.listUnansweredForTask(taskId);
  }

  /* ---------- Discovery + Execution Plan ---------- */
  /**
   * Discovery and planning are one read-only stage: the agent reads the codebase
   * and produces a single Execution Plan artifact (findings + chosen approach +
   * ordered change list + validation-by-criterion table). It parks at
   * human_plan_approval.
   *
   * Re-entered by a plan REJECTION or a human-review BOUNCE-to-plan; in that case
   * the prior planning session is RESUMED and sent only the reviewer's comment,
   * so the model revises the plan it already wrote in-context rather than
   * cold-prompting a fresh session that re-derives everything from scratch.
   */
  async createDiscovery(taskId: string): Promise<Task> {
    const { task, state } = this.stateOf(taskId);

    // Brand-new / empty repo short-circuit: if the checkout has no actual code
    // content, there is nothing to explore or plan against. Skip the read-only
    // agent run entirely and write a deterministic Execution Plan artifact, so
    // the lifecycle parks at plan approval instead of spending an agent turn
    // "checking" an empty folder. Detection is PROGRAMMATIC (fs signals).
    const project = this.store.getProject(task.projectId);
    const wt = this.store.getActiveWorktree(taskId);
    const cwd = wt?.worktreePath ?? project?.repoPath;
    if (cwd && existsSync(cwd) && isEmptyRepo(cwd)) {
      this.store.createArtifact({
        taskId: task.id,
        kind: 'execution_plan',
        title: 'Execution Plan (empty repository)',
        body:
          'No existing code content detected in the project checkout, so the ' +
          'codebase exploration was skipped. This is a brand-new repository: ' +
          'build directly from the brief rather than mapping existing files and ' +
          'conventions.',
      });
      return this.transition(taskId, submitPlan(state));
    }

    const reentryComment = this.reviewerFeedbackForStage(taskId, 'discovery');
    if (reentryComment) {
      // Re-entry (plan rejection or bounce-to-plan): resume the planning session
      // and send only the reviewer's comment, revising the in-context plan.
      await this.produceStageArtifactResuming(task, 'execution_plan', 'discovery', reentryComment);
    } else {
      await this.produceStageArtifact(task, 'execution_plan', 'discovery');
    }
    return this.transition(taskId, submitPlan(state));
  }

  /**
   * Capture the **pre-change static-analysis baseline** — runs the project's
   * typecheck/lint/test commands against the UNCHANGED checkout (the project's
   * main repoPath, on the default branch — NOT the task worktree) and returns
   * the per-kind results. Used by Verification to tell a NEW failure from one
   * the repo already had: a kind that fails post-change but also failed here is
   * pre-existing and must NOT park the task.
   *
   * Baseline is no longer a lifecycle stage. It is captured lazily, inside
   * Verification, and ONLY when there is a post-change failure to adjudicate —
   * so a fully green run never pays the cost. Returns `null` when no baseline
   * can be taken (no commands configured, or no real pre-change checkout on
   * disk); the caller then falls back to gating on absolute pass/fail.
   *
   * Runtime-independent: this is a SHELL step, so it does NOT depend on the
   * project's agentRuntime.
   */
  private async captureBaseline(
    taskId: string,
    changedTestPaths: string[] = [],
  ): Promise<ValidationResult[] | null> {
    const { task } = this.stateOf(taskId);
    const project = this.store.getProject(task.projectId);

    // The pre-change state lives in the project's own checkout (default branch),
    // which the task's worktree branched FROM and never mutates. Running here
    // gives a true "before" without disturbing the worktree's changes.
    const baseCwd = project?.repoPath && existsSync(project.repoPath) ? project.repoPath : null;
    const hasAnyCommand = project?.typecheckCommand || project?.testCommand || project?.lintCommand;
    if (!baseCwd || !hasAnyCommand) return null;

    // Scope the baseline test run to the SAME changed paths as the post-change run
    // so the comparison is apples-to-apples (and so we never run the whole repo
    // suite just to baseline a single-file change).
    const kinds: { kind: ValidationKind; command: string }[] = [
      { kind: 'typecheck', command: project?.typecheckCommand ?? '' },
      { kind: 'test', command: scopeTestCommand(project?.testCommand ?? '', changedTestPaths) },
      { kind: 'lint', command: project?.lintCommand ?? '' },
    ];

    const results: ValidationResult[] = [];
    for (const { kind, command } of kinds) {
      results.push(await this.validation.run({ taskId, cwd: baseCwd, kind, command }));
    }

    // Store it so the comparison is auditable in the UI alongside the post-change
    // Validation Report. Attributed to the static_checks stage run.
    const stageRunId = this.store.stageRunForStage(taskId, 'static_checks')?.id ?? null;
    this.store.createArtifact({
      taskId: task.id,
      stageRunId,
      kind: 'baseline_evidence',
      title: 'Baseline Evidence (pre-change)',
      body: renderBaselineReport(results),
    });
    return results;
  }

  async approvePlan(
    taskId: string,
    comment?: string,
    opts: { skipE2e?: boolean } = {},
  ): Promise<Task> {
    const { state } = this.stateOf(taskId);
    this.requireNoUnansweredQuestions(taskId);
    this.store.recordApproval({ taskId, gate: 'execution_plan', decision: 'approved', comment });
    // Optional: the human can opt out of the feature E2E stage here (e.g. a
    // non-UI / trivial change). Persisted on the task; completeStaticChecks reads
    // it to route past feature_e2e. Mirrors the skipWorktree choice at the brief
    // gate. The static checks (typecheck/test/lint) always still run.
    if (opts.skipE2e) {
      this.store.setSkipE2eOnTask(taskId, true);
    }
    const updated = this.transition(taskId, approveExecutionPlan(state));
    // Auto-advance: implementation -> static_checks -> feature_e2e (unless
    // skipped) -> self-review, parking at the human review gate.
    return this.advanceUntilGate(updated.id);
  }

  async rejectPlan(taskId: string, comment?: string): Promise<Task> {
    const { state } = this.stateOf(taskId);
    this.store.recordApproval({ taskId, gate: 'execution_plan', decision: 'rejected', comment });
    const updated = this.transition(taskId, rejectExecutionPlan(state));
    // discovery is auto-advanceable: re-run the discovery+plan stage (which now
    // threads the rejection feedback and resumes the planning session) and park
    // back at the plan gate, rather than leaving the task stuck with no plan.
    return this.advanceUntilGate(updated.id);
  }

  /* ---------- Implementation / Validation / Self-review ---------- */
  completeImplementation(taskId: string): Task {
    const { state } = this.stateOf(taskId);
    return this.transition(taskId, completeImplementation(state));
  }

  /**
   * Perform the implementation stage for the auto-advance driver.
   *
   * For a `claude` project this RUNS the real coding agent (awaited, in the task
   * worktree) and advances to validation only if it succeeded — so the lifecycle
   * never reaches Verification on an unchanged worktree. A failed run parks the
   * task at `implementation` (the driver detects the unchanged stage and stops),
   * surfacing the failure instead of green-checking work that never happened.
   *
   * Bounce redo (the answer to "why does the agent rewrite from scratch every
   * time?"): when this is a human_review bounce — there is a prior implementation
   * session AND a reviewer comment — RESUME that session and send ONLY the
   * comment as the next turn, mirroring the brief-rejection path in `rejectBrief`.
   * The session already holds the plan + the code it wrote, so the model adjusts
   * its own work in-context (~2-5 turns) instead of cold-starting: re-reading the
   * plan, re-exploring the worktree, and re-deriving a change it already made.
   *
   * If the resume fails (the session aged out of the CLI's store), fall back to a
   * cold run with the comment threaded in as reviewer feedback — same shape as
   * the brief path — rather than parking on a resume that can't be recovered.
   *
   * For a `mock` project the mock agent makes no real edits, so this stays the
   * plain transition — the mock walk is intentionally a no-op at this stage.
   */
  async runImplementation(taskId: string): Promise<Task> {
    const { task, state } = this.stateOf(taskId);
    const project = this.store.getProject(task.projectId);
    // Mock projects keep the no-op transition (no real agent, no edits).
    if (!this.runsRealAgent(task)) {
      return this.transition(taskId, completeImplementation(state));
    }

    const wt = this.store.getActiveWorktree(taskId);
    const repoPath = wt?.worktreePath ?? project!.repoPath;

    // A bounce redo resumes the prior implementation session and sends ONLY the
    // reviewer's comment. We only resume when BOTH exist: a captured session id
    // and a bounce comment to continue it with. A first build (no prior session,
    // no bounce feedback) cold-starts as before.
    const feedback = this.reviewerFeedbackForStage(taskId, 'implementation');
    const sessionId = this.store.latestSessionForStage(taskId, 'implementation');
    const resume = sessionId && feedback ? { sessionId, message: feedback } : undefined;

    let result = await this.runImplementationOnce(task, repoPath, { resume, feedback });

    // Resume failed (e.g. the session aged out): don't park on an unrecoverable
    // resume. Redo from a fresh session with the comment threaded in as feedback,
    // mirroring the brief-rejection fallback.
    if (resume && result.status !== 'succeeded') {
      result = await this.runImplementationOnce(task, repoPath, {
        resume: undefined,
        feedback,
      });
    }

    // Only advance to validation when the agent actually completed. A failed run
    // leaves the task parked at `implementation`; the driver stops on the
    // unchanged stage rather than validating an unimplemented change.
    if (result.status !== 'succeeded') {
      return this.store.getTask(taskId)!;
    }
    return this.transition(taskId, completeImplementation(state));
  }

  /**
   * One awaited implementation agent run, ungated and autonomous. Resume mode
   * sends only the reviewer's comment (the session holds the rest); a cold run
   * builds the full stage packet with `feedback` threaded in as reviewer
   * feedback. Persists the transcript + produced artifacts under the stage run.
   */
  private async runImplementationOnce(
    task: Task,
    repoPath: string,
    opts: { resume?: { sessionId: string; message: string }; feedback?: string },
  ): Promise<AgentRunResult> {
    const stageRunId = this.store.stageRunForStage(task.id, 'implementation')?.id ?? null;
    const project = this.store.getProject(task.projectId);
    const { result } = await this.runExecutor.runToCompletion({
      taskId: task.id,
      stage: 'implementation',
      adapter: this.adapterFor(task),
      // Autonomous run: no human is watching the stream to approve edits, so run
      // ungated. The implementation tool policy is `acceptEdits`, so Edit/Write/
      // Bash auto-approve and the agent can actually apply the plan.
      ungated: true,
      worktreePath: repoPath,
      contextArtifactIds: this.store.listArtifacts(task.id).map((a) => a.id),
      contextArtifacts: this.resolveStageContext(task.id, 'implementation'),
      allowedTools: allowedToolsForStage('implementation'),
      ...this.modelEffortFor(task, 'implementation'),
      taskTitle: task.title,
      rawRequest: task.rawRequest,
      skillText: this.skillTextForStage('implementation', repoPath, project),
      repoProfile: this.repoProfileFor(repoPath),
      // Resuming sends ONLY the comment as the next turn (see `resume`); a cold
      // run threads the comment into a fresh stage packet instead.
      reviewerFeedback: opts.resume ? undefined : opts.feedback,
      resume: opts.resume,
      persistResult: ({ transcript, produced }) => {
        this.store.createArtifact({
          taskId: task.id,
          stageRunId,
          kind: transcript.kind as ArtifactKind,
          title: transcript.title,
          body: transcript.body,
        });
        for (const p of produced) {
          this.store.createArtifact({
            taskId: task.id,
            stageRunId,
            kind: p.kind as ArtifactKind,
            title: p.title,
            body: p.body,
          });
        }
      },
    });
    return result;
  }

  /**
   * Verification — part 1 of 2: STATIC CHECKS (the former static half of the
   * single `verification` stage). Runs the project's shell typecheck/test/lint
   * scoped to the changed files and parks on a NEW failure. No E2E here; the
   * feature-specific E2E is a separate stage ({@link runFeatureE2e}) so it can
   * park on its own real test verdict and be skipped independently.
   *
   * The cold self-review agent pass is launched HERE (for claude projects, after
   * the gate passes) so it overlaps the rest of verification and always runs —
   * it reviews the diff, which exists regardless of whether E2E is skipped.
   */
  async runStaticChecks(taskId: string): Promise<Task> {
    const { task, state } = this.stateOf(taskId);
    const project = this.store.getProject(task.projectId);
    const wt = this.store.getActiveWorktree(taskId);
    // Validation runs against the worktree where the agent's edits live. A stub
    // worktree carries a path that was never created on disk, so prefer it only
    // when it actually exists; otherwise fall back to the project repo path.
    const cwd =
      wt && existsSync(wt.worktreePath)
        ? wt.worktreePath
        : project?.repoPath && existsSync(project.repoPath)
          ? project.repoPath
          : process.cwd();

    // Scope the test command to the files THIS task changed so validation runs
    // only the touched tests, not the whole repo suite (which on the enterprise
    // `app` repo is `bin/pytest -m unit` over the entire monorepo — multi-minute
    // and, since validation is synchronous, a daemon-wide freeze). The baseline
    // (below) reuses the SAME paths so the before/after comparison is scoped alike.
    const changedTestPaths = await this.changedTestPaths(taskId);

    // ---- Static half: shell typecheck/test/lint -> validation_report ----
    const kinds: { kind: ValidationKind; command: string }[] = [
      { kind: 'typecheck', command: project?.typecheckCommand ?? '' },
      { kind: 'test', command: scopeTestCommand(project?.testCommand ?? '', changedTestPaths) },
      { kind: 'lint', command: project?.lintCommand ?? '' },
    ];

    const results: ValidationResult[] = [];
    for (const { kind, command } of kinds) {
      const result = await this.validation.run({ taskId, cwd, kind, command });
      results.push(result);
      this.store.recordValidationRun({
        taskId,
        command: command.trim() || `(no ${kind} command configured)`,
        status: result.status,
        artifactId: null,
      });
    }

    this.store.createArtifact({
      taskId: task.id,
      kind: 'validation_report',
      title: 'Validation Report',
      body: renderValidationReport(results),
    });

    // ---- Static gate: adjudicate NEW failures before advancing, so a regression
    // parks here without burning a QA *or* a self-review pass on code that's about
    // to bounce. Gate on NEW failures only — a post-change failure the repo
    // already had pre-change (same check failing in the lazily-captured baseline)
    // is not a regression and must not park, else pre-existing red blocks delivery
    // forever.
    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length > 0) {
      const baseline = await this.captureBaseline(taskId, changedTestPaths);
      // No baseline available (no commands / no pre-change checkout) -> fall back
      // to the strict absolute gate: any failure parks.
      const preexistingKinds = new Set(
        (baseline ?? []).filter((b) => b.status === 'failed').map((b) => b.kind),
      );
      const newFailures = failed.filter((r) => !preexistingKinds.has(r.kind));
      if (newFailures.length > 0) {
        return this.store.getTask(taskId)!;
      }
      // Every post-change failure was already failing pre-change: advance, but
      // the stored baseline + validation reports make the call auditable.
    }

    // ---- Past the gate: run the cold self-review (real-agent projects only). It
    // READS the finished diff and never mutates it. Awaited so the self_review
    // artifact deterministically exists before we advance (completeSelfReview then
    // skips a redundant second cold pass). The scoped re-review on a bounce is
    // left to completeSelfReview (it owns the prior-findings context). A
    // self-review failure does NOT park — completeSelfReview re-runs it.
    const cwdExists =
      (wt && existsSync(wt.worktreePath)) || !!(project?.repoPath && existsSync(project.repoPath));
    if (this.runsRealAgent(task) && cwdExists) {
      await this.runColdSelfReview(task, cwd);
    }

    return this.transition(taskId, completeStaticChecks(state, { skipE2e: task.skipE2e }));
  }

  /**
   * Verification — part 2 of 2: FEATURE E2E (the former agent-QA half). The agent
   * authors a feature-specific Playwright spec and runs it via the QA harness;
   * the gate reads the harness's machine-readable verdict (NOT the agent's
   * completion status). Parks on a failing or empty verdict.
   *
   * Skipped entirely when the human chose `skipE2e` at the plan gate — in that
   * case the transition in completeStaticChecks already routed past this stage,
   * so this is a defensive no-op if it is ever reached with the flag set.
   */
  async runFeatureE2e(taskId: string): Promise<Task> {
    const { task, state } = this.stateOf(taskId);
    if (task.skipE2e) {
      return this.transition(taskId, completeFeatureE2e(state));
    }
    const project = this.store.getProject(task.projectId);
    const wt = this.store.getActiveWorktree(taskId);
    const cwd =
      wt && existsSync(wt.worktreePath)
        ? wt.worktreePath
        : project?.repoPath && existsSync(project.repoPath)
          ? project.repoPath
          : process.cwd();
    const cwdExists =
      (wt && existsSync(wt.worktreePath)) || !!(project?.repoPath && existsSync(project.repoPath));

    if (this.runsRealAgent(task) && cwdExists) {
      // The QA agent writes + runs a feature spec via the harness; produceDemoEvidence
      // now gates on the harness verdict, not agent completion. Park on a bad verdict.
      const demoOk = await this.produceDemoEvidence(task, cwd);
      if (!demoOk) {
        return this.store.getTask(taskId)!;
      }
    } else {
      // Mock runtime / no real checkout: keep the shell-only behavior. Run the
      // project's e2eCommand for real if configured, else fall back to a mock
      // bundle. This is a SHELL command — no agent.
      const e2eCommand = project?.e2eCommand ?? '';
      if (e2eCommand.trim() && cwdExists) {
        const e2eResult = await this.validation.run({
          taskId,
          cwd,
          kind: 'e2e',
          command: e2eCommand,
        });
        this.store.recordValidationRun({
          taskId,
          command: e2eCommand,
          status: e2eResult.status,
          artifactId: null,
        });
        // Park on a failed shell E2E too — this is the mock-path analogue of the
        // verdict gate above.
        if (e2eResult.status === 'failed') {
          this.store.createArtifact({
            taskId: task.id,
            kind: 'demo_evidence',
            title: 'Demo Evidence (E2E bundle)',
            body: renderDemoReport(e2eResult),
          });
          return this.store.getTask(taskId)!;
        }
        this.store.createArtifact({
          taskId: task.id,
          kind: 'demo_evidence',
          title: 'Demo Evidence (E2E bundle)',
          body: renderDemoReport(e2eResult),
        });
      } else {
        this.addMockArtifact(task, 'demo_evidence');
      }
    }

    return this.transition(taskId, completeFeatureE2e(state));
  }

  /**
   * The FIRST-PASS (cold) self-review agent run, produced eagerly in the
   * verification fork so it overlaps the QA bundle instead of running as a later
   * sequential stage. Real (claude) projects only — the mock self_review is left
   * to {@link completeSelfReview}.
   *
   * Runs UNGATED, exactly like the QA run ({@link produceDemoEvidence}): the
   * auto-advance driver invokes verification with no human at the terminal, and
   * the review policy allows Bash (`default` mode) — a gated run would raise a
   * permission prompt per Bash call that nobody answers and deadlock. It is
   * therefore wired through the executor directly rather than `produceStageArtifact`
   * (which is gated). Best-effort: a failure is swallowed (logged on the run
   * record) so it can't reject the fork's Promise.all or park the stage;
   * {@link completeSelfReview} re-runs self-review if no artifact landed.
   */
  private async runColdSelfReview(task: Task, repoPath: string): Promise<void> {
    // First pass ONLY. On a bounce a prior self_review exists and the re-run must
    // be the SCOPED re-review (prior findings + bounce comment + diff), which
    // completeSelfReview owns — a cold full-scope pass here would re-surface
    // nice-to-haves as blockers and never converge (the rereview-scope fix).
    const hasPriorReview = this.store.listArtifacts(task.id).some((a) => a.kind === 'self_review');
    if (hasPriorReview) return;

    // Attribute to the static_checks stage-run: the agent_self_review stage-run
    // doesn't exist yet (the cold pass is launched from static_checks), so this
    // cold pass is recorded under the stage it actually ran in.
    const stageRunId = this.store.stageRunForStage(task.id, 'static_checks')?.id ?? null;
    const project = this.store.getProject(task.projectId);
    const outcome = await this.runExecutor.run({
      taskId: task.id,
      stage: 'agent_self_review' as Stage,
      adapter: this.adapterFor(task),
      ungated: true,
      worktreePath: repoPath,
      contextArtifactIds: this.store.listArtifacts(task.id).map((a) => a.id),
      contextArtifacts: this.resolveStageContext(task.id, 'agent_self_review'),
      allowedTools: allowedToolsForStage('agent_self_review'),
      ...this.modelEffortFor(task, 'agent_self_review'),
      taskTitle: task.title,
      rawRequest: task.rawRequest,
      skillText: this.skillTextForStage('agent_self_review', repoPath, project),
      repoProfile: this.repoProfileFor(repoPath),
      persistResult: ({ transcript, produced }) => {
        this.store.createArtifact({
          taskId: task.id,
          stageRunId,
          kind: transcript.kind as ArtifactKind,
          title: transcript.title,
          body: transcript.body,
        });
        for (const p of produced) {
          this.store.createArtifact({
            taskId: task.id,
            stageRunId,
            kind: p.kind as ArtifactKind,
            title: p.title,
            body: p.body,
          });
        }
      },
    });
    if (outcome.status !== 'succeeded') {
      logger.warn(
        { taskId: task.id, err: outcome.error ?? 'unknown' },
        'cold self-review (verification fork) failed; completeSelfReview will retry',
      );
    }
  }

  /**
   * Run the QA agent for `verification` and persist its produced
   * `demo_evidence` (plus the run transcript). Streams through the run executor
   * so the UI's live terminal attaches, and is AWAITED so the driver only
   * advances once the bundle exists. Returns whether the run succeeded.
   *
   * Composed like {@link produceStageArtifact}: the worktree cwd, the QA skill
   * text (`qa-e2e-playwright` + `qa-artifacts`), and the `verification` tool
   * policy (Bash + Task, file mutation hard-denied).
   */
  private async produceDemoEvidence(task: Task, repoPath: string): Promise<boolean> {
    const adapter = this.adapterFor(task);
    const stageRunId = this.store.stageRunForStage(task.id, 'feature_e2e')?.id ?? null;
    const project = this.store.getProject(task.projectId);

    // QA harness wiring. The workbench owns Playwright + the browser (see
    // apps/web/qa-harness); the agent only authors a spec. The agent writes the
    // spec into QA_SPEC_DIR (a workbench-side scratch dir — the TARGET repo stays
    // clean) and runs the harness, which boots the target via its devCommand and
    // records video/trace into QA_OUTPUT_DIR.
    const qaRoot = join(tmpdir(), 'wb-qa', task.id);
    const qaSpecDir = join(qaRoot, 'spec');
    const qaOutputDir = join(qaRoot, 'output');
    const harnessEnv: Record<string, string> = {
      QA_TARGET_DIR: repoPath,
      QA_DEV_COMMAND: project?.devCommand?.trim() || 'npx --yes serve -l 5173 .',
      QA_BASE_URL: process.env.WORKBENCH_QA_BASE_URL ?? 'http://localhost:5173',
      QA_SPEC_DIR: qaSpecDir,
      QA_OUTPUT_DIR: qaOutputDir,
      // The harness + its Playwright config + the browser live in the workbench,
      // not the target worktree (the agent's cwd). The agent runs the harness with
      // `pnpm -C "$QA_HARNESS_CWD" ...` so it executes from the workbench regardless
      // of cwd.
      QA_HARNESS_CWD: this.repoRoot,
    };

    const outcome = await this.runExecutor.run({
      taskId: task.id,
      stage: 'feature_e2e' as Stage,
      adapter,
      // Autonomous run: the auto-advance driver invokes this with no human at the
      // terminal to answer permission prompts. The QA agent legitimately needs
      // Bash (run the harness) to do its work, so a gated run would deadlock —
      // every Bash call raises a permission prompt that nobody answers. Run
      // ungated so the policy's allowed tools auto-approve, exactly as the
      // implementation stage does.
      ungated: true,
      worktreePath: repoPath,
      contextArtifactIds: this.store.listArtifacts(task.id).map((a) => a.id),
      contextArtifacts: this.resolveStageContext(task.id, 'feature_e2e'),
      allowedTools: allowedToolsForStage('feature_e2e'),
      ...this.modelEffortFor(task, 'feature_e2e'),
      taskTitle: task.title,
      rawRequest: task.rawRequest,
      skillText: this.skillTextForStage('feature_e2e', repoPath, project),
      repoProfile: this.repoProfileFor(repoPath),
      reviewerFeedback: this.reviewerFeedbackForStage(task.id, 'feature_e2e'),
      // Point the agent's shell at the shared QA harness + the target app.
      env: harnessEnv,
      persistResult: ({ transcript, produced }) => {
        this.store.createArtifact({
          taskId: task.id,
          stageRunId,
          kind: transcript.kind as ArtifactKind,
          title: transcript.title,
          body: transcript.body,
        });
        for (const p of produced) {
          this.store.createArtifact({
            taskId: task.id,
            stageRunId,
            kind: p.kind as ArtifactKind,
            title: p.title,
            body: p.body,
          });
        }
      },
    });

    // Agent liveness is necessary but NOT sufficient: a run that finishes its
    // turn while NARRATING a pass (or running zero specs) must not advance. Gate
    // on the harness's machine-readable verdict (Playwright JSON reporter ->
    // results.json), not the agent's prose or completion status.
    if (outcome.status !== 'succeeded') return false;
    const verdict = readPlaywrightVerdict(join(qaOutputDir, 'results.json'));
    if (!verdict.ok) {
      logger.warn(
        { taskId: task.id, reason: verdict.reason },
        'feature E2E verdict not passing; parking at feature_e2e',
      );
      // Still capture whatever proof/assets exist so the human can see WHY at the
      // parked stage, then signal the caller to park.
      this.captureDemoAssets(task.id, qaOutputDir);
      return false;
    }

    // Capture the durable proof: the Playwright video/trace the harness recorded
    // into QA_OUTPUT_DIR. Copy them into artifact storage and reference them from
    // the demo_evidence body so the proof survives.
    this.captureDemoAssets(task.id, qaOutputDir);
    return true;
  }

  /**
   * Find the Playwright video/trace files the harness recorded under `outputDir`,
   * copy them into durable artifact storage, and append their stored paths to the
   * `demo_evidence` artifact. Matches `*.webm` (video) and `trace*.zip` (trace).
   * De-dupes by stored filename so multiple scenarios' videos are all preserved.
   */
  private captureDemoAssets(taskId: string, outputDir: string): void {
    const found = existsSync(outputDir) ? findProofAssets(outputDir) : [];
    if (found.length === 0) return;

    const stored = found.map((src) => this.store.copyDemoAsset(taskId, src));

    const demo = this.store
      .listArtifacts(taskId)
      .filter((a) => a.kind === 'demo_evidence')
      .at(-1);
    if (!demo) return;
    const body = this.store.readArtifactBody(demo.id) ?? '';
    const section =
      `\n\n## Captured proof assets\n\n` +
      `These were copied out of the worktree into durable storage (they outlive ` +
      `the worktree):\n\n` +
      stored.map((rel) => `- \`${rel}\``).join('\n') +
      `\n`;
    this.store.updateArtifactBody(demo.id, body + section);
  }

  async completeSelfReview(taskId: string): Promise<Task> {
    const { task, state } = this.stateOf(taskId);
    // A bounce re-enters this stage. A cold, full-scope adversarial pass on the
    // re-run surfaces fresh nice-to-haves as if they were blockers and re-bounces,
    // so the loop never converges. On a bounce, scope the re-review: hand the
    // agent the prior findings + the new diff and ask only "were these resolved,
    // and did the fix introduce a BLOCKING regression?".
    const rereviewContext = await this.selfReviewRereviewContext(taskId);
    if (rereviewContext) {
      // Bounce path: run the scoped re-review.
      await this.produceStageArtifact(task, 'self_review', 'agent_self_review', {
        rejectionFeedback: rereviewContext,
      });
      return this.transition(taskId, completeSelfReview(state));
    }
    // First-pass path: the verification fork already produced the cold self_review
    // concurrently with the QA bundle (runColdSelfReview). If it landed, this stage
    // is a pure transition — DON'T re-run a second cold pass. Only produce here as
    // a fallback when the fork didn't run (mock runtime) or its run failed.
    const hasReview = this.store.listArtifacts(taskId).some((a) => a.kind === 'self_review');
    if (!hasReview) {
      await this.produceStageArtifact(task, 'self_review', 'agent_self_review');
    }
    return this.transition(taskId, completeSelfReview(state));
  }

  /**
   * Re-review packet for a BOUNCED self-review, or `undefined` on the first pass.
   *
   * The re-review signal is an UNADDRESSED `human_review` bounce — not bare
   * artifact presence (the verification fork now leaves a first-pass `self_review`
   * before this stage runs, so presence alone no longer distinguishes a bounce).
   * The packet carries the prior findings, the human's bounce comment, and the
   * current worktree diff so the re-run verifies resolution instead of re-reviewing
   * from scratch. Rendered under the `agent_self_review` re-review framing.
   */
  private async selfReviewRereviewContext(taskId: string): Promise<string | undefined> {
    const bounceComment = this.lastGateRejection(taskId, 'human_review', ['bounce']);
    if (!bounceComment) return undefined;
    const priorReviews = this.store.listArtifacts(taskId).filter((a) => a.kind === 'self_review');
    if (priorReviews.length === 0) return undefined;

    const priorFindings = (
      this.store.readArtifactBody(priorReviews[priorReviews.length - 1]!.id) ?? ''
    ).trim();
    const diff = await this.worktreeDiff(taskId).catch(() => '');

    const sections: string[] = [
      '### Prior self-review findings',
      priorFindings,
      '### Human reviewer bounce comment',
      bounceComment,
    ];
    if (diff.trim()) {
      sections.push('### Current worktree diff (post-fix)', '```diff', diff.trim(), '```');
    }
    return sections.join('\n\n');
  }

  /* ---------- Human review ---------- */
  async humanReviewComplete(taskId: string, comment?: string): Promise<Task> {
    const { state } = this.stateOf(taskId);
    this.requireNoUnansweredQuestions(taskId);
    this.store.recordApproval({ taskId, gate: 'human_review', decision: 'complete', comment });
    const updated = this.transition(taskId, humanReviewComplete(state));
    // Auto-advance: delivery_prep, parking at the human delivery gate.
    return this.advanceUntilGate(updated.id);
  }

  async humanReviewBounce(taskId: string, target: BounceTarget, comment?: string): Promise<Task> {
    const { task, state } = this.stateOf(taskId);
    // The bounce_packet's whole purpose is to carry the reviewer's feedback to
    // the re-entered stage — render the actual comment, not a static mock.
    this.addMockArtifact(task, 'bounce_packet', { rejectionFeedback: comment });
    this.store.recordApproval({ taskId, gate: 'human_review', decision: 'bounce', comment });
    const updated = this.transition(taskId, humanReviewBounce(state, target));
    // A bounce re-enters an auto-advanceable stage (implementation or
    // discovery) — drive it forward to the next gate.
    return this.advanceUntilGate(updated.id);
  }

  /* ---------- Delivery ---------- */
  /**
   * The artifact id to register as the delivery package after a `delivery_prep` run.
   * Prefers the produced `delivery_package` artifact (mock path + real claude
   * adapter). Falls back to the most recent artifact written under the delivery_prep
   * stage run — so an adapter that emits a generic kind still yields a non-blank PR
   * body — and finally to the most recent artifact overall. Null if none exist.
   */
  private deliveryArtifactId(taskId: string): string | null {
    const artifacts = this.store.listArtifacts(taskId); // ordered by createdAt asc
    const pkg = [...artifacts].reverse().find((a) => a.kind === 'delivery_package');
    if (pkg) return pkg.id;
    const stageRunId = this.store.stageRunForStage(taskId, 'delivery_prep')?.id ?? null;
    if (stageRunId) {
      const onStage = [...artifacts].reverse().find((a) => a.stageRunId === stageRunId);
      if (onStage) return onStage.id;
    }
    const last = artifacts[artifacts.length - 1];
    return last ? last.id : null;
  }

  /**
   * Synthesize the delivery package for a `merge_to_master` delivery WITHOUT an
   * agent run. The work lands as one squash commit (subject = task title), so the
   * body just needs to record what shipped and how it was checked — both of which
   * we already have from earlier stages. We stitch the latest execution plan and
   * self-review into a short commit-message body and write it as the
   * `delivery_package` artifact, attributed to the delivery_prep stage run.
   */
  private writeMergeDeliveryPackage(task: Task, target: string): void {
    const artifacts = this.store.listArtifacts(task.id); // createdAt asc
    const latestBody = (kind: ArtifactKind): string =>
      this.store
        .readArtifactBody(artifacts.filter((a) => a.kind === kind).at(-1)?.id ?? '')
        ?.trim() ?? '';
    const plan = latestBody('execution_plan');
    const review = latestBody('self_review');
    const sections = [task.title];
    if (plan) sections.push(`## Plan\n\n${plan}`);
    if (review) sections.push(`## Self-review\n\n${review}`);
    sections.push(`Delivery: ${target} (squash, linear history).`);
    this.store.createArtifact({
      taskId: task.id,
      stageRunId: this.store.stageRunForStage(task.id, 'delivery_prep')?.id ?? null,
      kind: 'delivery_package',
      title: `Delivery package: ${task.title}`,
      body: sections.join('\n\n'),
    });
  }

  async prepareDelivery(taskId: string): Promise<Task> {
    const { task, state } = this.stateOf(taskId);
    const project = this.store.getProject(task.projectId);
    const wt = this.store.getWorktree(taskId);
    const branch = wt?.branch ?? project?.defaultBranch ?? 'unknown';
    const mergeToMaster = project?.deliveryPolicy === 'merge_to_master';
    const target = mergeToMaster
      ? `merge ${branch} into ${project?.defaultBranch ?? 'default branch'}`
      : `PR from ${branch}`;

    // Two delivery shapes, two costs:
    //
    // - merge_to_master: the work lands as a single squash commit whose body no
    //   human reviews on a PR page. A fresh diff-reading agent run to compose that
    //   body is wasted latency — the squash subject is just the task title and the
    //   commit message can be synthesized from artifacts we already have (the plan
    //   + self-review). So skip the agent entirely and write the package locally.
    //   This is what makes a merge-to-master delivery effectively instant.
    //
    // - create_pr: the package IS the PR description a human reads, so spend the
    //   agent run. On the claude runtime this runs a REAL agent over the branch
    //   diff via the `pr-description` skill; otherwise `produceStageArtifact`
    //   falls back to the mock body.
    //
    // Either way we register the produced artifact as the delivery package: prefer
    // the `delivery_package` kind (mock path + real adapter), else fall back to the
    // most recent artifact written by this stage run (covers adapters that emit a
    // generic kind) so the body is never blank.
    if (mergeToMaster) {
      this.writeMergeDeliveryPackage(task, target);
    } else {
      await this.produceStageArtifact(task, 'delivery_package', 'delivery_prep');
    }
    const artifactId = this.deliveryArtifactId(taskId);
    if (!artifactId) {
      throw new HttpError(502, 'delivery_prep produced no artifact to use as the delivery package');
    }

    this.store.createDeliveryPackage({
      taskId,
      artifactId,
      target,
      status: 'prepared',
    });
    return this.transition(taskId, completeDeliveryPrep(state));
  }

  async approveDelivery(taskId: string, comment?: string): Promise<Task> {
    const { task, state } = this.stateOf(taskId);
    this.requireNoUnansweredQuestions(taskId);
    this.store.recordApproval({ taskId, gate: 'delivery', decision: 'approved', comment });

    // Publish the work. A delivery failure does not wedge the task — the failure
    // summary is stored and surfaced; the human can retry or close out manually.
    //
    // Two orthogonal decisions:
    // - WHERE the work lives (cwd + branch) follows task.worktreeMode:
    //   - 'worktree' (default): the per-task worktree on its feature branch.
    //   - 'direct': the project checkout on its defaultBranch.
    // - WHAT we do with it (open a PR vs merge into the default branch) follows
    //   the project's deliveryPolicy and is decided by the delivery adapter.
    const project = this.store.getProject(task.projectId);
    const wt = this.store.getActiveWorktree(taskId);
    const directTarget =
      task.worktreeMode === 'direct' && project?.repoPath && existsSync(project.repoPath)
        ? { cwd: project.repoPath, branch: project.defaultBranch }
        : null;
    const worktreeTarget =
      wt && existsSync(wt.worktreePath) ? { cwd: wt.worktreePath, branch: wt.branch } : null;
    const target = directTarget ?? worktreeTarget;
    if (target && project) {
      // PR body: the delivery package artifact (prepared at delivery_prep) is the
      // task's human-readable summary — thread it through as the PR description so
      // the opened PR isn't blank. Merges ignore it (no PR to describe).
      const deliveryPkg = this.store.getDeliveryPackage(taskId);
      const description = deliveryPkg?.artifactId
        ? (this.store.readArtifactBody(deliveryPkg.artifactId) ?? undefined)
        : undefined;
      const req = {
        taskId,
        cwd: target.cwd,
        branch: target.branch,
        baseBranch: project.defaultBranch,
        // The squash-merge must run in the checkout that OWNS the base branch
        // (the project's primary checkout) — never inside the task worktree.
        baseCwd: project.repoPath && existsSync(project.repoPath) ? project.repoPath : undefined,
        target: task.title,
        description,
        policy: project.deliveryPolicy,
      };
      let result = await this.delivery.publish(req);

      // Merge conflict: try once to resolve it with the agent (any real runtime),
      // then re-attempt the publish. The conflict pre-check committed nothing, so
      // a failed resolution leaves the branch untouched.
      if (result.status === 'conflict' && this.runsRealAgent(task)) {
        const resolved = await this.resolveDeliveryConflict(task, target.cwd, {
          conflicts: result.conflicts,
          baseBranch: project.defaultBranch,
        });
        if (resolved) result = await this.delivery.publish(req);
      }

      // Still conflicted (resolution skipped, failed, or didn't clear it) OR the
      // publish itself failed: record the blocker and DO NOT advance. The task
      // stays at the delivery gate so the human can fix the cause and re-approve.
      // 409 surfaces the reason. (Closing out on a failed publish would record a
      // false success: a live run reached `done` with nothing delivered.)
      if (result.status === 'conflict' || result.status === 'failed') {
        this.store.markDeliveryPublished(taskId, {
          status: 'prepared',
          prUrl: null,
          summary: result.summary,
        });
        throw new HttpError(409, result.summary);
      }

      this.store.markDeliveryPublished(taskId, {
        status: result.status === 'published' ? 'published' : 'prepared',
        prUrl: result.url,
        summary: result.summary,
      });
    }

    const updated = this.transition(taskId, approveDelivery(state));
    // Auto-advance: publish -> closeout (terminal).
    return this.advanceUntilGate(updated.id);
  }

  /**
   * Hand a delivery merge conflict to the agent: run the `delivery_conflict`
   * stage in the work tree so it reproduces the merge and resolves the conflicts
   * in place. Returns true if the run succeeded (the caller re-attempts the
   * publish), false otherwise. The conflicted-file list and base branch are
   * threaded in as reviewer feedback — the prompt seam the agent already reads.
   */
  private async resolveDeliveryConflict(
    task: Task,
    cwd: string,
    info: { conflicts: string[]; baseBranch: string },
  ): Promise<boolean> {
    const adapter = this.adapterFor(task);
    const feedback =
      `Base branch: ${info.baseBranch}\n` +
      `Conflicted files:\n${info.conflicts.map((f) => `- ${f}`).join('\n')}`;
    const outcome = await this.runExecutor.run({
      taskId: task.id,
      // Not a lifecycle Stage — a one-off agent run keyed by name. The agents
      // package resolves its prompt + tool policy from this string.
      stage: 'delivery_conflict' as Stage,
      adapter,
      worktreePath: cwd,
      contextArtifactIds: this.store.listArtifacts(task.id).map((a) => a.id),
      contextArtifacts: this.resolveStageContext(task.id, 'delivery_conflict'),
      allowedTools: allowedToolsForStage('delivery_conflict'),
      ...this.modelEffortFor(task, 'delivery_conflict'),
      taskTitle: task.title,
      rawRequest: task.rawRequest,
      repoProfile: this.repoProfileFor(cwd),
      reviewerFeedback: feedback,
      persistResult: ({ transcript, produced }) => {
        // delivery_conflict is a one-off resolution run, not a lifecycle stage,
        // so it has no stage_run to attribute to — store cross-cutting (null).
        this.store.createArtifact({
          taskId: task.id,
          stageRunId: null,
          kind: transcript.kind as ArtifactKind,
          title: transcript.title,
          body: transcript.body,
        });
        for (const p of produced) {
          this.store.createArtifact({
            taskId: task.id,
            stageRunId: null,
            kind: p.kind as ArtifactKind,
            title: p.title,
            body: p.body,
          });
        }
      },
    });
    return outcome.status === 'succeeded';
  }

  rejectDelivery(taskId: string, comment?: string): Task {
    const { state } = this.stateOf(taskId);
    this.store.recordApproval({ taskId, gate: 'delivery', decision: 'rejected', comment });
    return this.transition(taskId, rejectDelivery(state));
  }

  /* ---------- Closeout ---------- */
  closeout(taskId: string): Task {
    // No closeout artifact: the timeline already carries the brief, plan,
    // validation, review, and delivery package. Closeout is a pure transition.
    const { state, task } = this.stateOf(taskId);
    const done = this.transition(taskId, closeout(state));
    // Distill this task's durable decisions into the project's memory log so the
    // NEXT task's discovery/planning starts from them. Best-effort and detached:
    // a summarizer failure (or a slow agent run) must NOT block or fail closeout.
    // The .catch is the whole point — it converts any rejection into a logged
    // no-op so a memory failure can never crash the daemon or fail the task.
    void this.appendTaskMemory(task).catch((err) => {
      logger.warn(
        { taskId, err: err instanceof Error ? err.message : String(err) },
        'project memory append failed (closeout still completed)',
      );
    });
    return done;
  }

  /**
   * The durable artifact kinds whose PROSE carries decisions worth remembering
   * across tasks: what was built, the chosen approach + alternatives rejected,
   * review findings, and the delivery summary. Ordered as they read.
   */
  private static readonly memorySourceKinds: ArtifactKind[] = [
    'task_brief',
    'execution_plan',
    'self_review',
    'delivery_package',
  ];

  /**
   * Append one distilled "durable decisions" entry for a completed task to its
   * project's memory log. On the claude runtime this runs a one-shot summarizer
   * over the task's decision-bearing artifacts; on mock it appends a deterministic
   * stub so the loop is exercisable without an API key. Returns silently when
   * there's nothing to summarize.
   */
  private async appendTaskMemory(task: Task): Promise<void> {
    const project = this.store.getProject(task.projectId);
    const artifacts = this.store.listArtifacts(task.id);
    const sources: { label: string; body: string }[] = [];
    for (const kind of LifecycleService.memorySourceKinds) {
      const latest = artifacts.filter((a) => a.kind === kind).at(-1);
      if (!latest) continue;
      const body = this.store.readArtifactBody(latest.id);
      if (body?.trim()) sources.push({ label: ARTIFACT_KIND_LABELS[kind] ?? kind, body });
    }
    if (sources.length === 0) return; // nothing durable to remember

    const date = new Date().toISOString().slice(0, 10);
    const heading = `## ${date} — ${task.title}`;

    if (!this.runsRealAgent(task)) {
      // Mock path: deterministic stub, no agent call.
      const lines = sources.map((s) => `- (${s.label}) recorded`).join('\n');
      this.store.appendProjectMemory(task.projectId, `${heading}\n${lines}`);
      return;
    }

    const prompt = memorySummaryPrompt(task.title, sources);
    const adapter = this.adapterFor(task);
    const result = await adapter.runStageAgent({
      taskId: task.id,
      // Off-lifecycle one-shot: `promptOverride` bypasses the stage packet, so the
      // stage value is ONLY a label. It must NOT be a real lifecycle stage —
      // `buildProduced` keys skill-compliance + empty-artifact banners off the
      // stage, and impersonating `delivery_prep` prepended a bogus
      // "missing summary/changes" warning into the memory entry (the summary has
      // no such fields). A non-stage label carries no required fields → no banner.
      stage: PROJECT_MEMORY_STAGE_LABEL as Stage,
      // `runsRealAgent` above returned true, so the project exists.
      worktreePath: project!.repoPath,
      contextArtifactIds: [],
      allowedTools: [],
      ...this.modelEffortFor(task, PROJECT_MEMORY_STAGE_LABEL),
      taskTitle: task.title,
      rawRequest: task.rawRequest,
      promptOverride: prompt,
    });
    // Strip the redundant fenced ```json block (the system prompt asks every run
    // to end with one) — the stored memory is read back into future discovery
    // prompts as PROSE, so the json would be duplicated noise there. This is the
    // SAME logic that keeps json out of `## Prior context` (see renderPriorContext).
    const raw = result.produced[0]?.body?.trim() || result.transcript.body.trim();
    const body = stripStructuredJson(raw);
    if (!body) return;
    this.store.appendProjectMemory(task.projectId, `${heading}\n\n${body}`);
  }

  /* ---------- Auto-advance driver ---------- */

  /**
   * The work method that performs an auto-advanceable stage and transitions to
   * the next stage. Each does the stage's work (mock artifacts today; real
   * streaming agent runs are triggered separately and feed these) and applies
   * the pure transition.
   */
  private readonly stageWork: Partial<Record<Stage, (taskId: string) => Task | Promise<Task>>> = {
    discovery: (id) => this.createDiscovery(id),
    implementation: (id) => this.runImplementation(id),
    static_checks: (id) => this.runStaticChecks(id),
    feature_e2e: (id) => this.runFeatureE2e(id),
    agent_self_review: (id) => this.completeSelfReview(id),
    delivery_prep: (id) => this.prepareDelivery(id),
    publish: (id) => this.closeout(id),
  };

  /**
   * Drive a task forward through auto-advanceable (non-gate) stages until it
   * parks at the next human gate, reaches a terminal stage, or is blocked by an
   * unanswered question. Non-gate stages no longer require a human click; the
   * 4 gates still do.
   *
   * Returns the task at its resting stage. Called after each gate-clearing
   * action (brief/plan approval, review complete, delivery approval) and after
   * a bounce re-enters an auto-advanceable stage.
   */
  /**
   * Recovery action: re-enter the auto-advance driver for a parked task.
   * Normally the driver runs inside the gate-clearing POST; if that request
   * dies (daemon restart, crash), the task is left at an auto-advanceable
   * stage with nothing to kick it. Refuses while a run is in flight so a
   * stray click can't double-run the current stage.
   */
  async resume(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new HttpError(404, `Task not found: ${taskId}`);
    if (this.activeAgentRun(taskId)) {
      throw new HttpError(409, 'a run is already in flight for this task');
    }
    return this.advanceUntilGate(taskId);
  }

  /**
   * Boot reconciliation — resume the conversations behind interrupted runs.
   *
   * For each task that has an `interrupted` run (daemon died mid-run), re-drive
   * it through {@link advanceUntilGate}, which re-runs the interrupted stage. The
   * stage reads all of its persisted context (prior artifacts/findings), so no
   * deliverable is lost — only the in-flight model turn — and a real-claude stage
   * whose prior session is still resumable continues that conversation via the
   * stage's own resume path; otherwise it regenerates from the durable context.
   *
   * Runs detached, sequentially (one task at a time — no spawn stampede), off the
   * boot critical path. Per-task failures are isolated: a parked task that can't
   * resume (repo gone, run still in flight, stage errored) is logged and skipped
   * so it can never abort the batch or wedge boot. Returns per-task outcomes.
   */
  async resumeInterruptedTasks(): Promise<{ resumed: number; skipped: number }> {
    // Dedupe to one task per interrupted run (a task may have several).
    const taskIds = [...new Set(this.store.listInterruptedRuns().map((r) => r.taskId))];
    let resumed = 0;
    let skipped = 0;
    for (const taskId of taskIds) {
      const log = logger.child({ taskId, component: 'boot-resume' });
      try {
        const task = this.store.getTask(taskId);
        if (!task) {
          skipped++;
          continue;
        }
        if (task.status === 'done' || task.status === 'abandoned') {
          skipped++;
          log.info({ status: task.status }, 'boot-resume: task already terminal — skipping');
          continue;
        }
        // A run that came back to life (e.g. its event log replays) blocks resume —
        // never double-drive a stage.
        if (this.activeAgentRun(taskId)) {
          skipped++;
          log.info('boot-resume: a run is already in flight — skipping');
          continue;
        }
        // Don't re-drive a real-agent task whose checkout vanished; it would just
        // fail the agent. Mock tasks have no real repo dependency.
        const wt = this.store.getActiveWorktree(taskId);
        const cwd = wt?.worktreePath ?? this.store.getProject(task.projectId)?.repoPath;
        if (this.runsRealAgent(task) && (!cwd || !existsSync(cwd))) {
          skipped++;
          log.warn({ cwd }, 'boot-resume: worktree/repo missing — skipping');
          continue;
        }

        const fromStage = task.stage;
        const after = await this.advanceUntilGate(taskId);
        resumed++;
        log.info({ fromStage, toStage: after.stage }, 'boot-resume: re-drove parked task');
      } catch (err) {
        skipped++;
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'boot-resume: failed to resume task (isolated, batch continues)',
        );
      }
    }
    return { resumed, skipped };
  }

  /**
   * Resolve the worktree/repo path a run executed in — the identity anchor the
   * orphan reaper matches against the live process's command line before killing
   * it. Mirrors how {@link produceStageArtifact} picks the cwd (task worktree,
   * else the project checkout). Used only by boot reconciliation.
   */
  worktreePathForRun(run: AgentRun): string | undefined {
    const task = this.store.getTask(run.taskId);
    if (!task) return undefined;
    const wt = this.store.getActiveWorktree(run.taskId);
    return wt?.worktreePath ?? this.store.getProject(task.projectId)?.repoPath;
  }

  /**
   * The queue's entry point: drive a task from wherever it sits toward the next
   * gate. A brand-new task parks at `intake` (the brief is a manual "start"
   * action, never auto-run), so a scheduler that only called {@link
   * advanceUntilGate} would mark it running and then spin on a no-op. So when the
   * task is still at `intake` we fire the brief here first — exactly the action a
   * human would click to start it — and then hand off to `advanceUntilGate`,
   * which carries it to the first human gate. Idempotent: a task past intake goes
   * straight to `advanceUntilGate`.
   */
  async driveTask(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new HttpError(404, `Task not found: ${taskId}`);
    if (task.stage === 'intake') {
      await this.generateBrief(taskId);
    }
    return this.advanceUntilGate(taskId);
  }

  async advanceUntilGate(taskId: string): Promise<Task> {
    // Bound the loop defensively: at most one pass per lifecycle stage.
    for (let guard = 0; guard < STAGES.length + 1; guard++) {
      const task = this.store.getTask(taskId);
      if (!task) throw new HttpError(404, `Task not found: ${taskId}`);

      // Stop on a halted task. `publish` carries status `ready_to_publish`
      // (set by delivery approval) yet still needs closeout to run, so allow
      // that status through; only `done`/`abandoned` halt the driver.
      if (task.status === 'done' || task.status === 'abandoned') return task;
      // Stop at a gate or any stage the driver must not auto-run.
      if (!isAutoAdvanceable(task.stage)) return task;
      // Stop if a question is awaiting a human answer.
      if (this.store.listUnansweredForTask(taskId).length > 0) return task;

      const work = this.stageWork[task.stage];
      if (!work) return task; // no work mapping — park rather than spin
      await work(taskId);

      // If the stage's work did not advance the task (e.g. validation failed and
      // parked at verification), stop rather than re-running it forever.
      const after = this.store.getTask(taskId);
      if (after && after.stage === task.stage && after.status === task.status) {
        return after;
      }
    }
    return this.store.getTask(taskId)!;
  }

  /**
   * Gate-gating: a human cannot clear a gate while the agent has unanswered
   * questions for the task. Enforces the "answers required" decision
   * server-side (the UI also disables the approve button).
   */
  private requireNoUnansweredQuestions(taskId: string): void {
    if (this.store.listUnansweredForTask(taskId).length > 0) {
      throw new HttpError(409, 'answer the open question(s) before approving this gate');
    }
  }

  /* ---------- helpers ---------- */
  private transition(
    taskId: string,
    result: { stage: TaskState['stage']; status: TaskState['status']; note?: string },
  ): Task {
    return this.store.applyTransition(taskId, result);
  }
}

/**
 * Wrap reviewer feedback so a fresh full-context redo treats it as the priority.
 * Used when a session resume failed and we fall back to regenerating from
 * scratch: the model gets the whole stage packet PLUS this emphasized comment,
 * so the human's correction isn't lost among the original instructions.
 */
function emphasizeFeedback(comment: string): string {
  return [
    'The previous Task Brief was REJECTED. This is the single most important',
    'input — prioritize addressing it over the original instructions:',
    '',
    comment,
  ].join('\n');
}

const STATUS_ICON: Record<ValidationResult['status'], string> = {
  passed: '✅',
  failed: '❌',
  skipped: '⏭️',
};

/**
 * Recursively collect Playwright proof files under a directory: browser videos
 * (`*.webm`), screenshots (`*.png`/`*.jpg`/`*.jpeg`), and traces (`trace*.zip`).
 * Bounded-depth and best-effort — an unreadable subtree is skipped rather than
 * throwing.
 */
function findProofAssets(dir: string, depth = 0): string[] {
  if (depth > 6) return [];
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      out.push(...findProofAssets(abs, depth + 1));
    } else if (
      name.endsWith('.webm') ||
      name.endsWith('.png') ||
      name.endsWith('.jpg') ||
      name.endsWith('.jpeg') ||
      (name.startsWith('trace') && name.endsWith('.zip'))
    ) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Read the feature-E2E verdict from the Playwright JSON reporter output
 * (`results.json`, written by the QA harness config). This is the machine-readable
 * gate for the `feature_e2e` stage — the agent neither runs nor judges the tests
 * on its word; we read Playwright's own counts.
 *
 * `ok` requires: the file exists and parses, NO unexpected (failed) specs, AND at
 * least one expected (passed) spec. The `expected > 0` guard is the specific
 * defense against a run that NARRATES a pass while running zero specs (the
 * fabricated-PASS failure mode this whole split exists to close).
 */
export function readPlaywrightVerdict(resultsPath: string): { ok: boolean; reason: string } {
  let raw: string;
  try {
    raw = readFileSync(resultsPath, 'utf8');
  } catch {
    return { ok: false, reason: 'no results.json — the E2E harness did not run any spec' };
  }
  let report: { stats?: { expected?: number; unexpected?: number; flaky?: number } };
  try {
    report = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'results.json is not valid JSON' };
  }
  const stats = report.stats ?? {};
  const expected = stats.expected ?? 0;
  const unexpected = stats.unexpected ?? 0;
  if (unexpected > 0) {
    return { ok: false, reason: `${unexpected} E2E spec(s) failed` };
  }
  if (expected < 1) {
    return { ok: false, reason: 'no E2E specs ran (0 passed)' };
  }
  return { ok: true, reason: `${expected} E2E spec(s) passed` };
}

/** Render a real E2E run result as the demo_evidence artifact body. */
function renderDemoReport(result: ValidationResult): string {
  const icon = STATUS_ICON[result.status];
  const verdict =
    result.status === 'passed' ? 'PASSED' : result.status === 'failed' ? 'FAILED' : 'SKIPPED';
  return (
    `# Demo Evidence (E2E / Playwright Bundle)\n\n` +
    `**Verdict: ${icon} ${verdict}**\n\n` +
    `## Output\n\n\`\`\`\n${result.output.trim() || '(no output)'}\n\`\`\`\n`
  );
}

/** Render the baseline (pre-change) static-analysis results as a markdown artifact. */
function renderBaselineReport(results: ValidationResult[]): string {
  const verdict = results.some((r) => r.status === 'failed')
    ? 'FAILURES PRESENT (pre-change)'
    : 'CLEAN';
  const summary = results
    .map((r) => `- ${STATUS_ICON[r.status]} **${KIND_LABEL[r.kind]}** — ${r.status}`)
    .join('\n');
  const details = results
    .filter((r) => r.status !== 'skipped')
    .map(
      (r) =>
        `### ${KIND_LABEL[r.kind]} (${r.status})\n\n\`\`\`\n${r.output.trim() || '(no output)'}\n\`\`\``,
    )
    .join('\n\n');
  return (
    `# Baseline Evidence (Pre-Change Static Analysis)\n\n` +
    `**Pre-change state: ${verdict}**\n\n` +
    `> This is the baseline snapshot taken BEFORE implementation. ` +
    `Failures here reflect the repo's pre-existing state, not regression from this task.\n\n` +
    `${summary}\n\n${details}\n`
  );
}

/**
 * Verdict for a set of validation results. A green "PASSED" must not paper over
 * unverified work: a check that was SKIPPED (no command configured) is neither a
 * pass nor a fail, so it's surfaced explicitly — `FAILED`, `PASSED`, or
 * `PASSED (N skipped)` / `INCOMPLETE` when nothing actually ran.
 */
function verdictFor(results: ValidationResult[]): string {
  if (results.some((r) => r.status === 'failed')) return 'FAILED';
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const passed = results.filter((r) => r.status === 'passed').length;
  if (skipped === 0) return 'PASSED';
  // Nothing actually ran — every check was skipped. A bare "PASSED" here would
  // be a green check over zero verification, so call it INCOMPLETE.
  if (passed === 0) return `INCOMPLETE (${skipped} skipped, 0 run)`;
  return `PASSED (${skipped} skipped)`;
}

/** Render the captured validation results as a markdown report artifact. */
function renderValidationReport(results: ValidationResult[]): string {
  const verdict = verdictFor(results);
  const summary = results
    .map((r) => `- ${STATUS_ICON[r.status]} **${KIND_LABEL[r.kind]}** — ${r.status}`)
    .join('\n');
  const details = results
    .filter((r) => r.status !== 'skipped')
    .map(
      (r) =>
        `### ${KIND_LABEL[r.kind]} (${r.status})\n\n\`\`\`\n${r.output.trim() || '(no output)'}\n\`\`\``,
    )
    .join('\n\n');
  return `# Validation Report\n\n**Verdict: ${verdict}**\n\n${summary}\n\n${details}\n`;
}

/**
 * Stage LABEL for the closeout memory summarizer's one-shot run. Deliberately NOT
 * a real lifecycle stage: `buildProduced` (claude adapter) keys its skill-compliance
 * and empty-artifact banners off the stage name, so a real stage label (e.g.
 * `delivery_prep`, which requires `summary`/`changes`) would prepend a bogus
 * "unverified" warning into the memory entry. An off-lifecycle label has no
 * required fields and no structure contract → a clean entry.
 */
export const PROJECT_MEMORY_STAGE_LABEL = 'project_memory_summary';

/**
 * The one-shot prompt for the closeout memory summarizer. It distills a completed
 * task's decision-bearing artifacts into a SHORT list of DURABLE decisions — the
 * "why we did it this way" that the next task should inherit — explicitly NOT a
 * recap of what the task did. The output is appended verbatim under a dated
 * heading the daemon prepends, so the prompt asks for bullets only (no heading).
 */
export function memorySummaryPrompt(
  taskTitle: string,
  sources: { label: string; body: string }[],
): string {
  const blocks = sources.map((s) => `### ${s.label}\n\n${s.body}`).join('\n\n');
  return [
    `You are distilling DURABLE PROJECT MEMORY from a task that just shipped.`,
    ``,
    `Task: ${taskTitle}`,
    ``,
    `From the artifacts below, extract ONLY decisions future tasks must inherit:`,
    `architectural choices, implementation patterns, naming/convention decisions,`,
    `and notable trade-offs — each with the ONE-LINE reason it was chosen. These are`,
    `precedent for later work in this project.`,
    ``,
    `STRICT rules:`,
    `- Output 1–6 markdown bullets. Fewer is better; omit anything not durable.`,
    `- A "durable decision" outlives this task. A recap of what this task did is NOT`,
    `  durable — do not include it. If nothing is durable, output the single line`,
    `  \`- (no durable decisions)\`.`,
    `- Each bullet: the decision, then "— because <reason>". No preamble, no heading,`,
    `  no closing remarks. Bullets only.`,
    `- Be concrete (name the file/module/pattern), not generic.`,
    ``,
    `## Artifacts`,
    ``,
    blocks,
  ].join('\n');
}

/** Carries an HTTP status alongside the message so routes can map cleanly. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
