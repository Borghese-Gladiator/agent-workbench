import type { RunStateSnapshot, SemanticEvent, PhaseObservability, HumanGate } from '@awb/domain';
import { resolveRuntimeConfig } from '@awb/config';

/**
 * Thin HTTP client the worker uses to persist through the daemon's internal routes.
 * The worker holds only a read-only DB handle, so all writes funnel here — the daemon is the single
 * application writer (docs/storage.md). Base URL from the shared runtime config (`AWB_DAEMON_URL`,
 * else derived from the resolved daemon port), so an isolated stack's worker posts to ITS daemon.
 * Every call throws on a non-2xx so a failed persist fails the phase rather than letting the
 * lifecycle advance on unpersisted state.
 */
export function daemonBaseUrl(): string {
  return resolveRuntimeConfig().daemonUrl;
}

async function requestJson<T = unknown>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  const url = `${daemonBaseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`daemon ${method} ${path} failed to connect: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`daemon ${method} ${path} returned ${response.status}: ${text}`);
  }
  return (await response.json().catch(() => ({}))) as T;
}

async function postOrPut(method: 'POST' | 'PUT', path: string, body: unknown): Promise<void> {
  await requestJson(method, path, body);
}

export interface DaemonClient {
  upsertTask(input: {
    taskId: string;
    repositoryId: string;
    prompt: string;
    phase?: string;
    condition?: string;
    deliveryState?: string;
    pendingHumanGate?: HumanGate;
  }): Promise<void>;
  saveRunState(snapshot: RunStateSnapshot): Promise<void>;
  postEvent(event: SemanticEvent): Promise<void>;
  postObservability(payload: PhaseObservability): Promise<void>;
  /** Trigger repository discovery through the daemon (single writer) and return the snapshot id. */
  refreshRepository(repositoryId: string): Promise<{ snapshotId: string }>;
}

export function createDaemonClient(): DaemonClient {
  return {
    async upsertTask(input) {
      const { taskId, ...rest } = input;
      await postOrPut('PUT', `/internal/tasks/${encodeURIComponent(taskId)}`, rest);
    },
    async saveRunState(snapshot) {
      await postOrPut('PUT', `/internal/run-state/${encodeURIComponent(snapshot.taskId)}`, snapshot);
    },
    async postEvent(event) {
      await postOrPut('POST', `/internal/events`, event);
    },
    async postObservability(payload) {
      await postOrPut('POST', `/internal/observability`, payload);
    },
    async refreshRepository(repositoryId) {
      // The INTERNAL discover route runs the real snapshot write; the public /refresh route starts
      // the discovery workflow (whose activity calls this), so calling it here would recurse.
      const snapshot = await requestJson<{ snapshotId: string }>(
        'POST',
        `/internal/repositories/${encodeURIComponent(repositoryId)}/discover`,
        {},
      );
      return { snapshotId: snapshot.snapshotId };
    },
  };
}
