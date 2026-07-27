import type { FastifyInstance } from 'fastify';
import { getTemporalClient } from '../temporal-client.js';
import { TASK_QUEUE } from '../temporal-worker-constants.js';

export type ServiceState = 'ready' | 'unhealthy' | 'unknown';

export interface RuntimeStatus {
  ok: boolean;
  runtime: ServiceState;
  services: {
    temporal: ServiceState;
    worker: ServiceState;
    daemon: ServiceState;
  };
}

const PROBE_TIMEOUT_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Probes the runtime's dependencies from inside the daemon. The daemon is `ready` by definition
 * (it is answering this request). Temporal is `ready` when its task queue can be described;
 * `worker` is `ready` only when that task queue reports at least one live poller — a running
 * worker registers itself as a poller, so poller count is our proxy for "the worker is up".
 * A failure to reach Temporal at all leaves both `temporal` and `worker` as `unhealthy`.
 */
export async function describeRuntimeStatus(): Promise<RuntimeStatus> {
  let temporal: ServiceState = 'unhealthy';
  let worker: ServiceState = 'unhealthy';

  try {
    const client = await withTimeout(getTemporalClient(), PROBE_TIMEOUT_MS);
    const description = await withTimeout(
      client.connection.workflowService.describeTaskQueue({
        namespace: client.options.namespace,
        taskQueue: { name: TASK_QUEUE },
      }),
      PROBE_TIMEOUT_MS,
    );
    temporal = 'ready';
    worker = (description.pollers?.length ?? 0) > 0 ? 'ready' : 'unhealthy';
  } catch {
    // Temporal unreachable — leave temporal/worker as unhealthy.
  }

  const services = { temporal, worker, daemon: 'ready' as ServiceState };
  const runtime: ServiceState =
    temporal === 'ready' && worker === 'ready' && services.daemon === 'ready' ? 'ready' : 'unhealthy';

  return { ok: runtime === 'ready', runtime, services };
}

export function registerStatusRoute(app: FastifyInstance): void {
  app.get('/api/status', async (_request, reply) => {
    const status = await describeRuntimeStatus();
    reply.code(status.ok ? 200 : 503);
    return status;
  });
}
