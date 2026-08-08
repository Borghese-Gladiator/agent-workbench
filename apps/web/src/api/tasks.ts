export type TaskSize = 'S' | 'M' | 'L';

export interface TaskWorkflowState {
  taskId: string;
  repositoryId: string;
  /** The natural-language prompt, threaded through workflow state; used for the detail-page title. */
  prompt?: string;
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

/** Per-model token + cost breakdown for a task (from SQLite model_invocations, summed by model). */
export interface TokenBreakdown {
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number;
  };
  byModel: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheCreationInputTokens: number;
      costUsd: number;
    }
  >;
}

/**
 * Whether the durable projection (what the list/board read) is behind the live workflow. The detail
 * page reads live state, so it reports this so the UI can show "the index is behind" instead of
 * silently disagreeing with the list (the walkthrough's core failure).
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
  /** Per-model token/cost breakdown — already on the wire; previously dropped by the client type. */
  tokenBreakdown?: TokenBreakdown;
  /** Index-vs-live freshness for this task. */
  freshness?: TaskFreshness;
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
  // task-summary projection fields (the durable list/board read model). `derivedStatus` is the
  // canonical status from the daemon — the client must not re-derive it. `indexedAt` is the
  // projection clock; when it lags the live workflow, the detail page reports the index is behind.
  derivedStatus: string;
  attemptCount: number;
  openFindingCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  pendingGateReason: string | null;
  candidateSha: string | null;
  pullRequestUrl: string | null;
  indexedAt: string;
  /** Concise title (null → derive from prompt with deriveTaskTitle). */
  title: string | null;
  /** Cross-task retry lineage. */
  retryOfTaskId: string | null;
  rootTaskId: string | null;
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
  create: (repositoryId: string, prompt: string) =>
    request<{ taskId: string; workflowId: string }>('POST', '/tasks', { repositoryId, prompt }),
  getState: (repositoryId: string, taskId: string) =>
    request<TaskStateResponse>('GET', `/tasks/${repositoryId}/${taskId}`),
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
  /** Generalized gate decision — acts on ANY pending human gate by its id (stale-gate guarded). */
  decideGate: (repositoryId: string, taskId: string, gateId: string, decision: 'approve' | 'deny', comment?: string) =>
    request('POST', `/tasks/${repositoryId}/${taskId}/gates/${encodeURIComponent(gateId)}/decision`, {
      decision,
      ...(comment ? { comment } : {}),
    }),
  cancel: (repositoryId: string, taskId: string) => request('POST', `/tasks/${repositoryId}/${taskId}/cancel`),
  remove: (repositoryId: string, taskId: string) =>
    request<{ removed: string }>('DELETE', `/tasks/${repositoryId}/${taskId}`),
};
