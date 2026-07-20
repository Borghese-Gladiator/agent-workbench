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
  getRepository: (id: string) =>
    request<{ repository: Repository; latestSnapshot?: RepositorySnapshotSummary }>('GET', `/repositories/${id}`),
  refreshRepository: (id: string) => request('POST', `/repositories/${id}/refresh`),
  approveRepository: (id: string) => request('POST', `/repositories/${id}/approve`),
};
