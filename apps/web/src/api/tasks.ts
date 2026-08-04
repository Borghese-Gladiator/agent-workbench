export interface TaskWorkflowState {
  taskId: string;
  repositoryId: string;
  phase: string;
  condition: string;
  deliveryState: string;
  attemptNumber: number;
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

export interface TaskStateResponse {
  state: TaskWorkflowState;
  openFindings: string[];
  pendingHumanGate: TaskWorkflowState['pendingHumanGate'];
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
  createdAt: string;
  updatedAt: string;
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
  approveContract: (repositoryId: string, taskId: string, contractVersion: number) =>
    request('POST', `/tasks/${repositoryId}/${taskId}/approve-contract`, { contractVersion }),
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
