import type {
  TaskPhase,
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
}

export interface TaskWorkflowInput {
  taskId: string;
  repositoryId: string;
  prompt?: string;
}

/** The activity signature the Workflow calls once per phase attempt. Implemented for real in workers/temporal-worker. */
export type RunPhaseActivity = (
  phase: TaskPhase,
  state: TaskWorkflowState,
) => Promise<PhaseAttemptResult>;
