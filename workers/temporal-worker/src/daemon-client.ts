import type { RunStateSnapshot, SemanticEvent, PhaseObservability } from '@awb/domain';
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

// Cap each daemon call so a wedged handler (e.g. a heavy discovery scan) fails fast with a clear
// timeout rather than undici's opaque connection drop. Kept under the activity's start-to-close
// timeout so the abort, not the activity, is what surfaces.
const DAEMON_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

async function requestJson<T = unknown>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  const url = `${daemonBaseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DAEMON_REQUEST_TIMEOUT_MS),
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
  }): Promise<void>;
  saveRunState(snapshot: RunStateSnapshot): Promise<void>;
  postEvent(event: SemanticEvent): Promise<void>;
  postObservability(payload: PhaseObservability): Promise<void>;
  /** Trigger repository discovery through the daemon (single writer) and return the snapshot id. */
  refreshRepository(repositoryId: string): Promise<{ snapshotId: string }>;
  /** Task DAG orchestration: notify the daemon that this task released its draft PR, so the
   *  scheduler starts any blocked children stacked on it. Best-effort — never fail the phase on it. */
  notifyReleased(taskId: string): Promise<void>;
  /**
   * Persist a `start` command inferred over a task worktree and proven to boot, so a later exercise
   * run reuses it (Tier-1) instead of re-inferring. Write funnels through the daemon (single writer).
   */
  persistStartCommand(input: {
    repositoryId: string;
    command: string;
    cwd: string;
    validatedAtSha?: string;
  }): Promise<void>;
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
    async notifyReleased(taskId) {
      await postOrPut('POST', `/internal/task-released/${encodeURIComponent(taskId)}`, {});
    },
    async persistStartCommand(input) {
      const { repositoryId, ...body } = input;
      await postOrPut('POST', `/internal/repositories/${encodeURIComponent(repositoryId)}/commands`, body);
    },
  };
}
