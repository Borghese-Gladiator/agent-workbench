export type TaskSize = 'S' | 'M' | 'L';

export interface TaskWorkflowState {
  taskId: string;
  repositoryId: string;
  phase: string;
  condition: string;
  deliveryState: string;
  attemptNumber: number;
  /** Task size class; undefined until the specify classifier sets it. */
  size?: TaskSize;
  /** The ordered subset of phases this run walks; undefined before specify derives it. */
  phaseSet?: string[];
  latestCandidateEvidenceIds: string[];
  openFindingIds: string[];
  pendingHumanGate?: {
    id: string;
    taskId: string;
    phase: string;
    reason: string;
    summary: string;
    createdAt: string;
  };
  tokenUsageTotal: { inputTokens: number; outputTokens: number };
  runtimeMsByPhase: Record<string, number>;
}

/** Advisory maintainability annotation surfaced for the human (non-blocking). */
export interface MaintainabilityFinding {
  id: string;
  path?: string;
  line?: number;
  description: string;
}

/**
 * By-model token/cost rollup for a task. Computed server-side (getTokenBreakdown) and already on the
 * wire — main's client types dropped it, so the Usage & Time section never saw it. Re-added here.
 */
export interface TokenBreakdown {
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number | null;
  };
  byModel: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheCreationInputTokens: number;
      costUsd: number | null;
    }
  >;
}

/** The 12 runtime-attribution buckets per phase attempt (where wall-clock went). One row per attempt. */
export interface RuntimeAttributionRow {
  phase: string;
  environmentSetupMs: number;
  dependencyInstallMs: number;
  modelWaitMs: number;
  modelGenerationMs: number;
  toolExecutionMs: number;
  testExecutionMs: number;
  serviceStartupMs: number;
  qaExecutionMs: number;
  artifactProcessingMs: number;
  githubOperationMs: number;
  humanWaitMs: number;
  retryBackoffMs: number;
}

/**
 * Freshness envelope: whether the daemon answered from live Temporal state or fell back to the durable
 * projection, and whether the projection is known to lag the live workflow.
 */
export interface TaskFreshness {
  liveWorkflowAvailable: boolean;
  workflowUpdatedAt: string | null;
  indexedAt: string;
  isIndexBehind: boolean;
}

export interface TaskStateResponse {
  state: TaskWorkflowState;
  openFindings: string[];
  pendingHumanGate: TaskWorkflowState['pendingHumanGate'];
  /** Advisory maintainability findings (category maintainability, severity note). */
  maintainabilityFindings?: MaintainabilityFinding[];
  /** By-model token/cost rollup (already computed server-side; previously dropped by client types). */
  tokenBreakdown?: TokenBreakdown;
  /** Per-phase-attempt runtime buckets (already computed server-side; previously dropped). */
  runtimeAttribution?: RuntimeAttributionRow[];
  /** Freshness of this response (live vs durable-projection fallback). */
  freshness?: TaskFreshness;
}

/** Leaf of the execution tree: one model invocation's token/cost/time facts. */
export interface ModelInvocationNode {
  id: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  costUsd: number | null;
  startedAt: string;
  endedAt: string | null;
}

/** Per-session context-composition buckets (token count by source). */
export interface ContextCompositionNode {
  contractTokens: number;
  planTokens: number;
  diffTokens: number;
  evidenceTokens: number;
  findingsTokens: number;
  repositoryMapTokens: number;
  memoryTokens: number;
  instructionTokens: number;
}

/** Execution-tree level 2: an agent session with its model invocations + context composition. */
export interface AgentSessionNode {
  id: string;
  phase: string;
  runtime: string;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  invocations: ModelInvocationNode[];
  contextComposition: ContextCompositionNode | null;
}

/** Execution-tree level 1: a phase attempt with its child agent sessions. */
export interface PhaseAttemptNode {
  id: string;
  phase: string;
  attemptNumber: number;
  retryOf: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  sessions: AgentSessionNode[];
}

export interface ExecutionTreeResponse {
  taskId: string;
  phaseAttempts: PhaseAttemptNode[];
}

/** A committed QA-media artifact the Evidence Viewer can play/preview locally. */
export interface TaskMediaArtifact {
  id: string;
  kind: string;
  mediaType: string;
  byteSize: number;
}

/** URL of a single artifact's raw bytes, served by the daemon with its real content-type. */
export function artifactContentUrl(artifactId: string): string {
  return `/api/artifacts/${artifactId}/content`;
}

/**
 * Mirrors the daemon's persisted task record (see apps/daemon/src/routes/tasks.ts CreatedTaskRecord).
 * `phase`/`condition`/`deliveryState` come from the SQLite tasks row; `repositoryName` is joined from
 * the repositories table so the UI can show a human-readable name instead of a UUID.
 */
export interface TaskSummary {
  taskId: string;
  repositoryId: string;
  repositoryName: string | null;
  workflowId: string;
  prompt: string;
  phase: string;
  condition: string;
  deliveryState: string;
  size: TaskSize | null;
  createdAt: string;
  updatedAt: string;
  // Projection fields from the durable task_summary read model (TASK-80/81). The list/board/overview
  // read these so they keep advancing after a task parks awaiting-human.
  derivedStatus: string;
  attemptCount: number;
  openFindingCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  pendingGateReason: string | null;
  candidateSha: string | null;
  pullRequestUrl: string | null;
  title: string | null;
  retryOfTaskId: string | null;
  rootTaskId: string | null;
  indexedAt: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const message = (json as { error?: string }).error ?? `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return json as T;
}

export const tasksApi = {
  list: () => request<TaskSummary[]>('GET', '/tasks'),
  create: (
    repositoryId: string,
    prompt: string,
    opts?: { size?: TaskSize; title?: string; retryOfTaskId?: string },
  ) =>
    request<{ taskId: string; workflowId: string }>('POST', '/tasks', {
      repositoryId,
      prompt,
      ...(opts?.size ? { size: opts.size } : {}),
      ...(opts?.title ? { title: opts.title } : {}),
      ...(opts?.retryOfTaskId ? { retryOfTaskId: opts.retryOfTaskId } : {}),
    }),
  getState: (repositoryId: string, taskId: string) =>
    request<TaskStateResponse>('GET', `/tasks/${repositoryId}/${taskId}`),
  executionTree: (repositoryId: string, taskId: string) =>
    request<ExecutionTreeResponse>('GET', `/tasks/${repositoryId}/${taskId}/execution-tree`),
  listMedia: (repositoryId: string, taskId: string) =>
    request<TaskMediaArtifact[]>('GET', `/tasks/${repositoryId}/${taskId}/media`),
  approveContract: (repositoryId: string, taskId: string, contractVersion: number, size?: TaskSize) =>
    request('POST', `/tasks/${repositoryId}/${taskId}/approve-contract`, { contractVersion, ...(size ? { size } : {}) }),
  rejectContract: (repositoryId: string, taskId: string, reason: string) =>
    request('POST', `/tasks/${repositoryId}/${taskId}/reject-contract`, { reason }),
  approvePlan: (repositoryId: string, taskId: string, planVersion: number) =>
    request('POST', `/tasks/${repositoryId}/${taskId}/approve-plan`, { planVersion }),
  rejectPlan: (repositoryId: string, taskId: string, reason: string) =>
    request('POST', `/tasks/${repositoryId}/${taskId}/reject-plan`, { reason }),
  cancel: (repositoryId: string, taskId: string) => request('POST', `/tasks/${repositoryId}/${taskId}/cancel`),
  remove: (repositoryId: string, taskId: string) =>
    request<{ removed: string }>('DELETE', `/tasks/${repositoryId}/${taskId}`),
};
