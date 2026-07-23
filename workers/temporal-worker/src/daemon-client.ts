import type { RunStateSnapshot, SemanticEvent, PhaseObservability } from '@awb/domain';

/**
 * Thin HTTP client the worker uses to persist through the daemon's internal routes (TASK-21/27).
 * The worker holds only a read-only DB handle, so all writes funnel here — the daemon is the single
 * application writer (spec §8 / docs/storage.md). Base URL from `AWB_DAEMON_URL`, defaulting to the
 * daemon's loopback port. Every call throws on a non-2xx so a failed persist fails the phase rather
 * than letting the lifecycle advance on unpersisted state (Decision 003).
 */
export function daemonBaseUrl(): string {
  return process.env.AWB_DAEMON_URL ?? 'http://127.0.0.1:4417';
}

async function postOrPut(method: 'POST' | 'PUT', path: string, body: unknown): Promise<void> {
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
  };
}
