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

export interface TaskStateResponse {
  state: TaskWorkflowState;
  openFindings: string[];
  /** Advisory maintainability findings (category maintainability, severity note). */
  maintainabilityFindings?: MaintainabilityFinding[];
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
  cancel: (repositoryId: string, taskId: string) => request('POST', `/tasks/${repositoryId}/${taskId}/cancel`),
  remove: (repositoryId: string, taskId: string) =>
    request<{ removed: string }>('DELETE', `/tasks/${repositoryId}/${taskId}`),
};
