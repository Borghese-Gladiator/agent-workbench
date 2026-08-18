/**
 * The only place apps/web talks to the outside world — all requests go through the daemon's
 * `/api` over HTTP/WebSocket. This file (and its callers) must never import a `packages/*`
 * module directly, touch the filesystem, or shell out — that's the "browser never touches the
 * filesystem, git, or a shell" invariant from AGENTS.md.
 */

export interface Repository {
  id: string;
  canonicalPath: string;
  name: string;
  remoteUrl?: string;
  defaultBranch: string;
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RepositorySnapshotSummary {
  id: string;
  headSha: string;
  createdAt: string;
}

/** A discovered/validated repository command surfaced in the repo-detail Commands & environment panel. */
export interface RepositoryCommandView {
  id: string;
  unitId: string | null;
  purpose: string;
  command: string;
  cwd: string;
  source: string;
  status: string;
  validatedAtSha: string | null;
  lastExitCode: number | null;
}

/** Expanded repository-detail payload: the repo, its latest snapshot, commands, repo-scoped tasks. */
export interface RepositoryDetail {
  repository: Repository;
  latestSnapshot: RepositorySnapshotSummary | null;
  commands: RepositoryCommandView[];
  tasks: import('./tasks.js').TaskSummary[];
  scopedTokenUsage: { inputTokens: number; outputTokens: number; costUsd: number | null };
}

export interface OverviewActivityItem {
  taskId: string;
  repositoryId: string;
  repositoryName: string | null;
  title: string | null;
  derivedStatus: string;
  at: string;
}

export interface OverviewResponse {
  factoryHealth: {
    total: number;
    running: number;
    awaitingHuman: number;
    blocked: number;
    failed: number;
    completed: number;
  };
  needsAttention: import('./tasks.js').TaskSummary[];
  currentState: Record<string, number>;
  recentActivity: OverviewActivityItem[];
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

export const api = {
  listRepositories: () => request<Repository[]>('GET', '/repositories'),
  addRepository: (canonicalPath: string, name?: string) =>
    request<Repository>('POST', '/repositories', { canonicalPath, name }),
  getRepository: (id: string) => request<RepositoryDetail>('GET', `/repositories/${id}`),
  refreshRepository: (id: string) => request('POST', `/repositories/${id}/refresh`),
  approveRepository: (id: string) => request('POST', `/repositories/${id}/approve`),
};

export const overviewApi = {
  get: () => request<OverviewResponse>('GET', '/overview'),
};
