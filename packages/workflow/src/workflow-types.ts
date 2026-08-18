import type {
  TaskPhase,
  TaskSize,
  RunCondition,
  DeliveryState,
  HumanGate,
  PhaseAttemptResult,
} from '@awb/domain';

/** Compact coordination state the Workflow keeps in memory — never large logs/videos/transcripts. */
export interface TaskWorkflowState {
  taskId: string;
  repositoryId: string;
  /** The natural-language task prompt, threaded from task creation so specify can draft a real contract. */
  prompt?: string;
  phase: TaskPhase;
  condition: RunCondition;
  deliveryState: DeliveryState;
  attemptNumber: number;
  latestCandidateEvidenceIds: string[];
  openFindingIds: string[];
  pendingHumanGate?: HumanGate;
  tokenUsageTotal: { inputTokens: number; outputTokens: number };
  runtimeMsByPhase: Partial<Record<TaskPhase, number>>;
  /**
   * Task size class, set once the specify phase's classifier runs (or seeded from an
   * intake hint / gate-time override). Drives `phaseSet`. Undefined until specify completes.
   */
  size?: TaskSize;
  /**
   * The ordered subset of `TASK_PHASE_ORDER` this run actually walks. Derived from `size`
   * when leaving specify; `nextPhase` walks this instead of the module constant. Undefined before
   * specify sets it, in which case advancement falls back to the full order.
   */
  phaseSet?: TaskPhase[];
  /**
   * True when a human set `size` at the contract gate. The specify candidate's classifier
   * result must NOT overwrite a human override, so this pins the size against the classifier.
   */
  sizeHumanOverridden?: boolean;
  /**
   * Base branch override (TASK-72 stacked PRs): the branch the worktree/branch is created from and
   * the PR opens against, when it must not be the repository default branch (e.g. a parent task's
   * delivered branch). Undefined for a root task, which uses the repository default branch.
   */
  baseBranch?: string;
  /**
   * A/B knob (TASK-61): when true this run omits the separate `program-design` phase from its phase
   * set, even at size L. Threaded from config at workflow-start so the deterministic workflow never
   * reads config live. Recorded on a semantic event so program-design vs no-program-design runs are
   * distinguishable for the rework/loop-back and reviewed-ratio comparison.
   */
  disableProgramDesign?: boolean;
}

export interface TaskWorkflowInput {
  taskId: string;
  repositoryId: string;
  prompt?: string;
  /** Optional intake size hint (e.g. CLI `--size`); the specify classifier uses it as a prior/override. */
  size?: TaskSize;
  /** Base branch override for stacked PRs (TASK-72); threaded into worktree + PR creation. */
  baseBranch?: string;
  /** A/B knob (TASK-61): drop the program-design phase for this run. Read from config at start. */
  disableProgramDesign?: boolean;
  /**
   * Present only on a continue-as-new re-seed: the full coordination state carried over
   * from the previous run so the new execution resumes exactly where the old one left off, with a
   * fresh (empty) event history. Absent on the initial start.
   */
  resumeState?: TaskWorkflowState;
}

/** The activity signature the Workflow calls once per phase attempt. Implemented for real in workers/temporal-worker. */
export type RunPhaseActivity = (
  phase: TaskPhase,
  state: TaskWorkflowState,
) => Promise<PhaseAttemptResult>;
