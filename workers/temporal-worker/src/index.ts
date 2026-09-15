import { Worker, NativeConnection } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initTelemetry, createLogger } from '@awb/telemetry';
import { resolveRuntimeConfig } from '@awb/config';
import * as activities from './activities/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The task queue this worker polls, resolved from the shared runtime config (env-driven,
 * `awb-task-queue` default). An isolated stack's worker polls ITS own queue so a workflow task is
 * never executed by a sibling worktree's worker running different code — the core multi-stack bug.
 */
export function taskQueueName(): string {
  return resolveRuntimeConfig().taskQueue;
}

/**
 * How long the worker keeps trying to reach Temporal before it gives up. `awb up` starts Temporal
 * and the worker together, so the worker regularly wins the race and hits `ConnectionRefused` on a
 * server that is seconds from listening (TASK-127). Dying on the first refusal turned a slow boot
 * into a permanently `unhealthy` worker.
 */
const CONNECT_RETRY_BUDGET_MS = 60_000;
const CONNECT_RETRY_INITIAL_MS = 250;
const CONNECT_RETRY_MAX_INTERVAL_MS = 4_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connects to Temporal, retrying with exponential backoff until the budget runs out. Only the LAST
 * error propagates, so a genuine misconfiguration (wrong address, bad TLS) still fails loudly rather
 * than being masked by the retries. `connect` and `delay` are injected for the unit test.
 */
export async function connectWithRetry(
  address: string,
  deps: {
    connect: (address: string) => Promise<NativeConnection>;
    delay?: (ms: number) => Promise<void>;
    now?: () => number;
    budgetMs?: number;
  },
): Promise<NativeConnection> {
  const delay = deps.delay ?? sleep;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? CONNECT_RETRY_BUDGET_MS;
  const deadline = now() + budgetMs;
  let interval = CONNECT_RETRY_INITIAL_MS;
  for (;;) {
    try {
      return await deps.connect(address);
    } catch (err) {
      if (now() >= deadline) throw err;
      await delay(interval);
      interval = Math.min(interval * 2, CONNECT_RETRY_MAX_INTERVAL_MS);
    }
  }
}

/**
 * How long the supervisor waits before rebuilding a worker whose poll loop ended (TASK-111). Backs
 * off so a Temporal server that is down for minutes is not hammered, and caps so recovery after a
 * WiFi outage is quick rather than exponentially late.
 */
const SUPERVISOR_INITIAL_BACKOFF_MS = 1_000;
const SUPERVISOR_MAX_BACKOFF_MS = 30_000;

/**
 * Keeps a worker polling across a network partition (TASK-111).
 *
 * Observed live: a WiFi outage killed the activities with `Connection closed mid-response`, and the
 * temporal-worker then went **idle for about three hours** — task-queue backlog 0, pollers apparently
 * alive, no workflow tasks executed. Only an explicit `awb restart worker` brought it back. A worker
 * whose poll loop ends must rebuild itself; nothing should require an operator at a keyboard.
 *
 * `worker.run()` resolving is ALSO how a clean shutdown looks, so the supervisor stops when asked
 * (`shouldContinue`) and otherwise treats the end of the loop — resolved or rejected — as a partition
 * to recover from. `build` and `delay` are injected so the recovery is unit-testable without
 * Temporal.
 */
export async function superviseWorker(deps: {
  build: () => Promise<Worker>;
  shouldContinue: () => boolean;
  delay?: (ms: number) => Promise<void>;
  onRestart?: (info: { attempt: number; backoffMs: number; reason: string }) => void;
  maxRestarts?: number;
}): Promise<void> {
  const delay = deps.delay ?? sleep;
  let backoff = SUPERVISOR_INITIAL_BACKOFF_MS;
  let attempt = 0;

  while (deps.shouldContinue()) {
    let reason = 'the poll loop ended';
    try {
      const worker = await deps.build();
      await worker.run();
      // A clean shutdown and a partition look identical from here, so `shouldContinue` is what
      // separates them — check it before treating this as something to recover from.
      if (!deps.shouldContinue()) return;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    if (!deps.shouldContinue()) return;

    attempt += 1;
    if (deps.maxRestarts !== undefined && attempt > deps.maxRestarts) return;
    deps.onRestart?.({ attempt, backoffMs: backoff, reason });
    await delay(backoff);
    backoff = Math.min(backoff * 2, SUPERVISOR_MAX_BACKOFF_MS);
  }
}

/** Builds a connected worker. Separated from `startWorker` so the supervisor can rebuild one. */
export async function buildWorker(): Promise<Worker> {
  // Boot OpenTelemetry before any activity runs. A no-op unless `awb up` set an OTLP
  // endpoint, so a plain test/dev run starts no exporter.
  initTelemetry('awb-worker');
  const cfg = resolveRuntimeConfig();
  // Connect to the resolved Temporal address so an isolated stack targets its own Temporal server,
  // not the default 7233 a sibling stack may hold.
  const connection = await connectWithRetry(cfg.temporalAddress, {
    connect: (address) => NativeConnection.connect({ address }),
  });
  const worker = await Worker.create({
    connection,
    taskQueue: cfg.taskQueue,
    // Resolve straight to the real package path, not through the node_modules/@awb symlink —
    // Temporal's webpack-based bundler writes its generated entrypoint's error output relative
    // to cwd rather than consistently following the symlink's resolved path, producing a
    // spurious ENOENT even though the file itself is written correctly. This exact absolute path
    // (repo-root-relative, matching pnpm's monorepo layout) is the same one already proven to
    // work in workers/temporal-worker's own Temporal integration test.
    workflowsPath: join(__dirname, '..', '..', '..', 'packages', 'workflow', 'dist', 'workflows.js'),
    activities,
    // Cap concurrent activity execution (TASK-112). A heavy phase (implement/verify) can spawn a
    // vitest worker pool, so Temporal's high default let N tasks fork hundreds of processes at once
    // and thrash a single-developer machine (observed load ~377 with 10 tasks). Bounding this to a
    // small env-driven value keeps the box responsive; the deferred activities run as slots free up.
    maxConcurrentActivityTaskExecutions: cfg.maxConcurrentActivities,
  });
  return worker;
}

/**
 * Boots the worker and keeps it polling. The supervisor rebuilds the connection AND the worker on
 * each restart: after a partition the old `NativeConnection` is attached to a dead socket, so
 * reusing it reproduces the very wedge this exists to fix.
 */
export async function startWorker(): Promise<void> {
  const logger = createLogger('awb-worker');
  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await superviseWorker({
    build: buildWorker,
    shouldContinue: () => running,
    onRestart: ({ attempt, backoffMs, reason }) => {
      logger.warn('worker poll loop ended — rebuilding', { attempt, backoffMs, reason });
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch((err: unknown) => {
    createLogger('awb-worker').error('worker boot failed', {
      error: err instanceof Error ? err.stack ?? err.message : String(err),
    });
    process.exitCode = 1;
  });
}
