import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_RUNTIMES,
  type AgentRun,
  type DetectedCommands,
  detectCommandsFromPackageJson,
  IllegalTransitionError,
  isAgentRuntime,
  isBounceTarget,
  isDeliveryPolicy,
  isWorktreeMode,
  type LifecycleAction,
  type PackageManager,
  type RuntimeConfig,
  type Stage,
  WORKTREE_MODES,
} from '@workbench/core';
import type { DeliveryAdapter } from '@workbench/delivery';
import { StaleWriteError, type Store } from '@workbench/store';
import type { WorktreeProvider } from '@workbench/worktree';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from './logger.js';
import { QueueService } from './queue-service.js';
import {
  type AgentFactory,
  HttpError,
  LifecycleService,
  type SyncValidationRunner,
} from './service.js';

export interface AppOptions {
  worktrees?: WorktreeProvider;
  worktreesDir?: string;
  /** Chooses the agent adapter per project runtime (mock | claude). */
  agentFor?: AgentFactory;
  /** Base URL the spawned MCP gate server relays back to (real-CLI runs). */
  daemonUrl?: string;
  /** Runs project validation commands; defaults to the real command runner. */
  validation?: SyncValidationRunner;
  /** Commits/pushes the branch and opens a PR; defaults to dry-run git delivery. */
  delivery?: DeliveryAdapter;
  /** The daemon's own repo root; a project at this path is self-targeting. Overridable for tests. */
  repoRoot?: string;
  /**
   * TEST-ONLY seam. Invoked inside the SSE handler in the window AFTER the live
   * subscription is registered but BEFORE persisted events are replayed —
   * exactly the gap where a naive replay-then-subscribe handler drops events.
   * A test emits an event here to prove the subscribe-before-replay handoff is
   * gap-free. May be async — the handler awaits it before replaying. Never set
   * in production.
   */
  onSseBeforeReplay?: (runId: string) => void | Promise<void>;
  /**
   * Invoked once with handles bound to the app's internal LifecycleService.
   *
   * Production uses it for BOOT RECONCILIATION (`resumeInterruptedTasks` +
   * `worktreePathForRun` for the orphan reaper) — the service is built inside
   * `createApp`, so this is how main.ts reaches it without leaking the instance.
   *
   * Tests also use it to launch a background run on the SAME executor the SSE
   * endpoints read from (`startRun`), now that the manual-trigger routes are gone.
   */
  onReady?: (handles: {
    startRun: (taskId: string, stage: Stage) => AgentRun;
    resumeInterruptedTasks: () => Promise<{ resumed: number; skipped: number }>;
    worktreePathForRun: (run: AgentRun) => string | undefined;
    /** Re-scan the queue after boot (re-drive running entries, tick newly-eligible). */
    resumeQueue: () => Promise<void>;
    /** Tear down the queue scheduler (timer + store subscription) — for test cleanup. */
    stopQueue: () => void;
  }) => void;
  /**
   * Safety-net poll interval (ms) for the queue scheduler. Defaults to the
   * QueueService default (30s); tests set 0 to disable the timer and drive ticks
   * via task-change events / explicit calls.
   */
  queuePollIntervalMs?: number;
}

/** How a demo-asset filename renders in the UI's center panel. */
export type AssetKind = 'video' | 'image' | 'trace' | 'other';

function assetKind(filename: string): AssetKind {
  const n = filename.toLowerCase();
  if (n.endsWith('.webm') || n.endsWith('.mp4')) return 'video';
  if (n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.gif'))
    return 'image';
  if (n.startsWith('trace') && n.endsWith('.zip')) return 'trace';
  return 'other';
}

/**
 * Accept only the known string fields of a {@link RuntimeConfig} from the request
 * body, dropping anything else. No credentials are accepted here — auth is the
 * runtime's own concern (Claude login / `pi` provider auth / env).
 */
function sanitizeRuntimeConfig(input: unknown): RuntimeConfig | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const src = input as Record<string, unknown>;
  const out: RuntimeConfig = {};
  for (const key of ['model', 'baseUrl', 'binary'] as const) {
    const v = src[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Builds the daemon's Express app. The browser talks ONLY to this API; it never
 * touches the filesystem, git, or SQLite directly. All mutations go through the
 * LifecycleService so the lifecycle rules are enforced in one place.
 */
export function createApp(store: Store, opts: AppOptions = {}): Express {
  const app = express();
  const svc = new LifecycleService(
    store,
    opts.worktrees,
    opts.worktreesDir,
    opts.agentFor,
    opts.daemonUrl,
    opts.validation,
    opts.delivery,
    opts.repoRoot,
  );

  // The multi-task queue schedules enqueued tasks under a dependency DAG; it
  // drives them through the SAME advanceUntilGate the gate actions use, so it
  // only orders execution, it never reimplements it. Started here so it is live
  // (event-driven off store changes) as soon as the app exists.
  // Under vitest, default the safety poll OFF: tests create many apps without an
  // explicit teardown, and a live interval + store subscription per app would leak
  // across cases (a late tick firing against a closed store flakes the suite). The
  // event-driven path still works in tests that opt in by calling start logic via
  // enqueue. Production/explicit callers get the real default (or their override).
  const queuePollIntervalMs = opts.queuePollIntervalMs ?? (process.env.VITEST ? 0 : undefined);
  const queue = new QueueService(store, (taskId) => svc.driveTask(taskId), {
    pollIntervalMs: queuePollIntervalMs,
  });
  const stopQueue = queue.start();

  // Hand boot reconciliation (and run-infra tests) handles bound to this app's
  // service/executor (see AppOptions.onReady).
  opts.onReady?.({
    startRun: (taskId, stage) => svc.startBackgroundRun(taskId, stage),
    resumeInterruptedTasks: () => svc.resumeInterruptedTasks(),
    worktreePathForRun: (run) => svc.worktreePathForRun(run),
    resumeQueue: () => queue.tick(),
    stopQueue,
  });

  app.use(cors());
  // Per-request structured logging: each request gets a `reqId` + method/status/
  // duration. When a route is run-scoped (notably the gate's `/ask` relay), bind
  // the `runId` so the request shows up on the same trace as the executor and the
  // gate server's stderr lines.
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => {
        const runId = (req.params as Record<string, string> | undefined)?.runId;
        return runId ? { runId } : {};
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  // Optional shared-secret gate (defense-in-depth on top of the loopback bind).
  // Off when WORKBENCH_TOKEN is unset, so local dev / tests / seed are untouched.
  // When set, every request must carry the token via `Authorization: Bearer <t>`
  // OR a `?token=<t>` query param — the query form exists because SSE is consumed
  // through EventSource, which cannot set request headers. `/api/health` and the
  // loopback-only MCP `/internal/*` callback are exempt.
  const TOKEN = process.env.WORKBENCH_TOKEN;
  if (TOKEN) {
    const expected = Buffer.from(TOKEN);
    const presented = (req: Request): string | undefined => {
      const auth = req.headers.authorization;
      if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
      const q = req.query.token;
      return typeof q === 'string' ? q : undefined;
    };
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/api/health' || req.path.startsWith('/internal/')) return next();
      const got = presented(req);
      const buf = got === undefined ? undefined : Buffer.from(got);
      // Length check first: timingSafeEqual throws on length mismatch.
      if (!buf || buf.length !== expected.length || !timingSafeEqual(buf, expected)) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      next();
    });
  }

  // Wrap async handlers so thrown errors hit the error middleware.
  const h =
    (fn: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve(fn(req, res)).catch(next);

  // Route :id params are always present for a matched route, but TS's
  // noUncheckedIndexedAccess types them as possibly-undefined; narrow once here.
  const param = (req: Request, name: string): string => {
    const v = req.params[name];
    if (v === undefined) throw new HttpError(400, `missing route param: ${name}`);
    return v;
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  /* ---------- Projects ---------- */
  app.get(
    '/api/projects',
    h((_req, res) => res.json(store.listProjects())),
  );

  app.post(
    '/api/projects',
    h((req, res) => {
      const b = req.body ?? {};
      if (!b.name || !b.repoPath || !b.defaultBranch) {
        throw new HttpError(400, 'name, repoPath and defaultBranch are required');
      }
      if (b.agentRuntime !== undefined && !isAgentRuntime(b.agentRuntime)) {
        throw new HttpError(
          400,
          `agentRuntime must be one of: ${AGENT_RUNTIMES.map((r) => `"${r}"`).join(', ')}`,
        );
      }
      if (b.deliveryPolicy !== undefined && !isDeliveryPolicy(b.deliveryPolicy)) {
        throw new HttpError(400, 'deliveryPolicy must be "create_pr" or "merge_to_master"');
      }
      // A real-agent project (any non-'mock' runtime, e.g. 'claude' or 'pi')
      // drives a live `git worktree`, so its repoPath must point at an existing
      // checkout. The 'mock' runtime uses the stub worktree provider and is
      // allowed a placeholder path (seed/tests only — the UI never offers the
      // mock runtime). Unspecified runtime defaults to 'mock' (matching the
      // store), so only enforce for explicit real runtimes.
      if (b.agentRuntime !== undefined && b.agentRuntime !== 'mock' && !existsSync(b.repoPath)) {
        throw new HttpError(400, `repoPath does not exist: ${b.repoPath}`);
      }
      res.status(201).json(
        store.createProject({
          name: b.name,
          description: b.description,
          repoPath: b.repoPath,
          defaultBranch: b.defaultBranch,
          agentRuntime: b.agentRuntime,
          runtimeConfig: sanitizeRuntimeConfig(b.runtimeConfig),
          deliveryPolicy: b.deliveryPolicy,
          testCommand: b.testCommand,
          lintCommand: b.lintCommand,
          typecheckCommand: b.typecheckCommand,
          e2eCommand: b.e2eCommand,
          devCommand: b.devCommand,
        }),
      );
    }),
  );

  // Best-effort: inspect a repo's package.json and suggest build commands so the
  // user doesn't have to remember them when registering a project. Reads only —
  // no install, no execution. Returns empty strings for anything not found.
  app.post(
    '/api/projects/detect-commands',
    h((req, res) => {
      const repoPath = (req.body ?? {}).repoPath;
      if (typeof repoPath !== 'string' || repoPath.trim() === '') {
        throw new HttpError(400, 'repoPath is required');
      }
      if (!existsSync(repoPath)) {
        throw new HttpError(400, `repoPath does not exist: ${repoPath}`);
      }
      res.json(detectProjectCommands(repoPath));
    }),
  );

  /* ---------- Tasks ---------- */
  app.get(
    '/api/tasks',
    h((_req, res) => res.json(store.listTasks())),
  );

  app.post(
    '/api/tasks',
    h((req, res) => {
      const b = req.body ?? {};
      if (!b.projectId || !b.title || !b.rawRequest) {
        throw new HttpError(400, 'projectId, title and rawRequest are required');
      }
      if (!store.getProject(b.projectId)) throw new HttpError(404, 'project not found');
      if (b.worktreeMode !== undefined && !isWorktreeMode(b.worktreeMode)) {
        throw new HttpError(
          400,
          `worktreeMode must be one of: ${WORKTREE_MODES.map((m) => `"${m}"`).join(', ')}`,
        );
      }
      res.status(201).json(
        store.createTask({
          projectId: b.projectId,
          title: b.title,
          rawRequest: b.rawRequest,
          ...(b.worktreeMode ? { worktreeMode: b.worktreeMode } : {}),
        }),
      );
    }),
  );

  /* ---------- Task queue ---------- */
  app.get(
    '/api/queue',
    h((_req, res) => res.json(queue.list())),
  );

  app.post(
    '/api/queue',
    h((req, res) => {
      const b = req.body ?? {};
      if (!b.taskId) throw new HttpError(400, 'taskId is required');
      const priority = b.priority === undefined ? undefined : Number(b.priority);
      if (priority !== undefined && Number.isNaN(priority)) {
        throw new HttpError(400, 'priority must be a number');
      }
      const dependsOn = b.dependsOn ?? null;
      const depsOk =
        dependsOn === null ||
        typeof dependsOn === 'string' ||
        (Array.isArray(dependsOn) && dependsOn.every((d: unknown) => typeof d === 'string'));
      if (!depsOk) {
        throw new HttpError(400, 'dependsOn must be a queue-entry id or array of ids');
      }
      res.status(201).json(
        queue.enqueue({
          taskId: b.taskId,
          dependsOn,
          priority,
        }),
      );
    }),
  );

  // Bulk-create a whole DAG of tasks + queue entries in one transaction.
  app.post(
    '/api/queue/dag',
    h((req, res) => {
      const b = req.body ?? {};
      if (!b || typeof b.projectId !== 'string' || !Array.isArray(b.tasks)) {
        throw new HttpError(400, 'body must be { projectId, tasks: [...] }');
      }
      // queue.enqueueDag validates the spec (keys/refs/cycle) and throws HttpError(400).
      res.status(201).json({ projectId: b.projectId, created: queue.enqueueDag(b) });
    }),
  );

  // Full task detail bundle for the timeline view.
  app.get(
    '/api/tasks/:id',
    h((req, res) => {
      const task = store.getTask(param(req, 'id'));
      if (!task) throw new HttpError(404, 'task not found');
      const project = store.getProject(task.projectId);
      res.json({
        task,
        project,
        // Derived: this project's repoPath is the daemon's own repo, so the
        // skip-worktree path is refused. The UI uses this to hide that action.
        selfTargeting: svc.isSelfTargeting(project?.repoPath),
        stageRuns: store.listStageRuns(task.id),
        artifacts: store.listArtifacts(task.id),
        approvals: store.listApprovals(task.id),
        worktree: store.getWorktree(task.id),
        delivery: store.getDeliveryPackage(task.id),
        validationRuns: store.listValidationRuns(task.id),
        agentRuns: store.listAgentRuns(task.id),
      });
    }),
  );

  // Delete a task and all its children (abandons the worktree first).
  app.delete(
    '/api/tasks/:id',
    h(async (req, res) => {
      await svc.deleteTask(param(req, 'id'));
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/artifacts/:id',
    h((req, res) => {
      const art = store.getArtifact(param(req, 'id'));
      if (!art) throw new HttpError(404, 'artifact not found');
      res.json({ ...art, body: store.readArtifactBody(art.id) });
    }),
  );

  // Edit an artifact's body (e.g. a human refining an agent-written brief/plan).
  app.patch(
    '/api/artifacts/:id',
    h((req, res) => {
      const b = req.body ?? {};
      if (typeof b.body !== 'string') throw new HttpError(400, 'body (string) is required');
      const updated = store.updateArtifactBody(param(req, 'id'), b.body);
      if (!updated) throw new HttpError(404, 'artifact not found');
      res.json({ ...updated, body: store.readArtifactBody(updated.id) });
    }),
  );

  // The durable QA proof assets (Playwright videos/screenshots/traces) a task
  // accumulated, so the human-review panel can embed them rather than just naming
  // them in the demo_evidence markdown.
  app.get(
    '/api/tasks/:id/assets',
    h((req, res) => {
      const taskId = param(req, 'id');
      if (!store.getTask(taskId)) throw new HttpError(404, 'task not found');
      const assets = store.listDemoAssets(taskId).map((name) => ({ name, kind: assetKind(name) }));
      res.json({ assets });
    }),
  );

  // Stream one demo-asset for inline display/download. The filename is validated
  // against traversal in the store; a bad name resolves to null -> 404.
  app.get(
    '/api/tasks/:id/assets/:filename',
    h((req, res) => {
      const abs = store.demoAssetPath(param(req, 'id'), param(req, 'filename'));
      if (!abs) throw new HttpError(404, 'asset not found');
      res.sendFile(abs);
    }),
  );

  /* ---------- Worktree ---------- */
  app.post(
    '/api/tasks/:id/worktree',
    h(async (req, res) => res.status(201).json(await svc.createWorktree(param(req, 'id')))),
  );
  app.get(
    '/api/tasks/:id/worktree/status',
    h(async (req, res) => res.json(await svc.refreshGitStatus(param(req, 'id')))),
  );
  app.get(
    '/api/tasks/:id/worktree/diff',
    h(async (req, res) => res.json({ diff: await svc.worktreeDiff(param(req, 'id')) })),
  );
  app.post(
    '/api/tasks/:id/worktree/abandon',
    h(async (req, res) => res.json(await svc.abandonWorktree(param(req, 'id')))),
  );
  app.post(
    '/api/tasks/:id/worktree/preserve',
    h((req, res) => res.json(svc.preserveWorktree(param(req, 'id')))),
  );

  /* ---------- Agent runs ---------- */
  // Agent runs are NOT triggered by a manual route. The auto-advance driver runs
  // every agent stage (brief/discovery/plan/implementation/verification/
  // self-review) as the lifecycle advances; the routes below are READ-ONLY views
  // of those runs (list / active / detail / SSE events) plus the question gate.

  // All of a task's agent runs, oldest-first. The UI uses the newest to keep the
  // read-only terminal mounted after a run finishes (replaying its transcript),
  // so the live stream — not the structured artifact — stays the primary view.
  app.get(
    '/api/tasks/:id/agent/runs',
    h((req, res) => res.json({ runs: svc.listAgentRuns(param(req, 'id')) })),
  );

  // The task's current in-flight run (running | awaiting_input), or null. The
  // UI polls this to attach its live terminal to whatever the daemon is doing.
  // NOTE: must register before `/runs/:runId` or `active` matches as a runId.
  app.get(
    '/api/tasks/:id/agent/runs/active',
    h((req, res) => res.json({ run: svc.activeAgentRun(param(req, 'id')) })),
  );

  // Run record + persisted events (a non-streaming snapshot).
  app.get(
    '/api/tasks/:id/agent/runs/:runId',
    h((req, res) => {
      const run = svc.getAgentRun(param(req, 'runId'));
      res.json({ run, events: svc.agentRunEvents(run.id) });
    }),
  );

  // Stop an in-flight run — kills its spawned CLI subprocess and marks it
  // failed. 404 if unknown, 409 if already terminal.
  app.post(
    '/api/tasks/:id/agent/runs/:runId/stop',
    h((req, res) => res.json({ run: svc.stopAgentRun(param(req, 'runId')) })),
  );

  // SSE notification stream for a TASK's state (stage / status / artifacts).
  // Notification-only: each event carries no payload — the client refetches
  // GET /api/tasks/:id on receipt. That makes duplicate / out-of-order events
  // harmless (no replay, seq, or dedup needed, unlike the run-event stream).
  // We send an initial `changed` so a fresh or reconnecting client syncs once,
  // then one per store notification, plus a heartbeat comment to hold the
  // connection open through proxies.
  app.get('/api/tasks/:id/events', (req, res) => {
    const taskId = param(req, 'id');
    // Validate before opening the stream (mirrors the run-events route).
    if (!store.getTask(taskId)) {
      return res.status(404).json({ error: 'task not found' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const sendChanged = () => {
      if (!res.writableEnded) res.write('event: changed\ndata: {}\n\n');
    };
    sendChanged(); // initial sync for late/reconnecting clients
    const unsubscribe = svc.subscribeToTask(taskId, sendChanged);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // SSE event stream for a run. Subscribes to the live bus FIRST, then replays
  // persisted events, then flushes anything the live subscription captured while
  // replaying — all guarded by a monotonic seq cursor so every event is sent
  // exactly once. (Subscribing after replay would drop any event appended in the
  // window between the replay query and the subscribe call.)
  app.get('/api/tasks/:id/agent/runs/:runId/events', async (req, res) => {
    const runId = param(req, 'runId');
    // Validate the run exists (maps to 404 via the catch below).
    try {
      svc.getAgentRun(runId);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return res.status(status).json({ error: (err as Error).message });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // The high-water mark of seqs already written to this response. Replay,
    // buffered-live flush, and the live tail all advance it; any event at or
    // below it is a duplicate and skipped. This is what makes the replay/live
    // handoff gap-free AND duplicate-free.
    const lastIdHeader = req.headers['last-event-id'];
    let cursor = Number(
      (Array.isArray(lastIdHeader) ? lastIdHeader[0] : lastIdHeader) ?? req.query.lastEventId ?? 0,
    );
    if (!Number.isFinite(cursor)) cursor = 0;

    // Write an event iff it's strictly newer than the cursor, advancing it.
    const send = (ev: { seq: number; type: string; payload: unknown }) => {
      if (res.writableEnded || ev.seq <= cursor) return;
      res.write(`id: ${ev.seq}\n`);
      res.write(`event: ${ev.type}\n`);
      res.write(`data: ${JSON.stringify(ev.payload)}\n\n`);
      cursor = ev.seq;
    };
    // A terminal event ends the response; checked after every write so a
    // terminal seen via replay OR the live bus closes the stream.
    const endIfTerminal = () => {
      const status = svc.getAgentRun(runId).status;
      if (status === 'succeeded' || status === 'failed') res.end();
    };

    // Subscribe FIRST. While `replaying` is true, live events are buffered (not
    // written) so they interleave correctly with the replay by seq; afterwards
    // they stream straight through the cursor-guarded `send`.
    let replaying = true;
    const buffered: { seq: number; type: string; payload: unknown }[] = [];
    const unsubscribe = svc.subscribeToRun(runId, (ev) => {
      if (replaying) {
        buffered.push(ev);
        return;
      }
      send(ev);
      endIfTerminal();
    });
    req.on('close', () => unsubscribe());

    // TEST-ONLY: simulate an event landing in the subscribe→replay window. The
    // event it emits is captured by the live subscription's buffer above; a
    // replay-then-subscribe handler would miss it entirely.
    await opts.onSseBeforeReplay?.(runId);

    // Replay persisted events after the cursor, then flush the buffered live
    // events (sorted, de-duped against the cursor). The cursor guard drops the
    // overlap between the replay snapshot and the live events captured during it.
    for (const ev of svc.agentRunEvents(runId, cursor)) send(ev);
    buffered.sort((a, b) => a.seq - b.seq);
    for (const ev of buffered) send(ev);
    replaying = false;

    // Re-check terminal AFTER the handoff: the run may have finished during
    // replay (its terminal event is now flushed), in which case close out.
    endIfTerminal();
  });

  // Answer a mid-run question — resumes the paused run. The answer shape is
  // validated against the question (400 on mismatch; 409 if already answered).
  app.post(
    '/api/tasks/:id/agent/questions/:questionId/answer',
    h((req, res) => {
      const b = req.body ?? {};
      if (!b.answer || typeof b.answer !== 'object') {
        throw new HttpError(400, 'answer is required ({selected:[]} | {text})');
      }
      res.json(svc.answerQuestion(param(req, 'questionId'), b.answer));
    }),
  );

  // Unanswered questions for a task (gate-gating: the UI disables approve while
  // any remain).
  app.get(
    '/api/tasks/:id/questions/unanswered',
    h((req, res) => res.json(svc.listUnansweredQuestions(param(req, 'id')))),
  );

  // INTERNAL: the spawned `workbench_ask` MCP server relays a tool call here and
  // long-polls — the daemon holds this response open until the human answers,
  // then returns the answer to the MCP server (which returns it to the CLI).
  app.post(
    '/internal/agent/runs/:runId/ask',
    h(async (req, res) => {
      const b = req.body ?? {};
      if (typeof b.question !== 'string' || typeof b.header !== 'string') {
        throw new HttpError(400, 'header and question are required');
      }
      const answer = await svc.askQuestion(param(req, 'runId'), {
        header: b.header,
        question: b.question,
        options: Array.isArray(b.options) ? b.options : null,
        multiSelect: Boolean(b.multiSelect),
        permission: b.permission ?? undefined,
      });
      res.json({ answer });
    }),
  );

  /* ---------- Lifecycle actions ---------- */
  // `path` is typed to LifecycleAction so the registered routes are statically
  // checked against the canonical LIFECYCLE_ACTIONS list MCP derives its enum from.
  const action = (path: LifecycleAction, fn: (id: string, body: any) => unknown) =>
    app.post(
      `/api/tasks/:id/${path}`,
      h(async (req, res) => res.json(await fn(param(req, 'id'), req.body ?? {}))),
    );

  // Only GATE actions are exposed over HTTP. The non-gate stages (discovery,
  // baseline-evidence, execution-plan, complete-implementation, validation-demo,
  // self-review, delivery-prep, closeout) are no longer manual: the
  // auto-advance driver runs them internally after each gate is cleared. Their
  // service methods remain (the driver calls them); only the routes are gone.
  // Reject/bounce must carry a comment — it's the only guidance the regenerated
  // artifact/agent gets. Returns the trimmed comment or 400s.
  const requireComment = (b: { comment?: unknown }): string => {
    if (typeof b.comment !== 'string' || !b.comment.trim()) {
      throw new HttpError(400, 'a review comment is required to reject or bounce');
    }
    return b.comment.trim();
  };

  action('generate-brief', (id) => svc.generateBrief(id));
  // Recovery: re-enter the auto-advance driver for a task parked at an
  // auto-advanceable stage (daemon restart / crash killed the driving POST).
  action('resume', (id) => svc.resume(id));
  action('approve-brief', (id, b) => {
    // A self-targeting project (repoPath == the daemon's own repo) may never skip
    // the worktree — reject loudly so a caller/UI sees the refusal instead of it
    // being silently overridden. (The service also refuses as a backstop.)
    if (b.skipWorktree) {
      const task = store.getTask(id);
      const project = task ? store.getProject(task.projectId) : null;
      if (svc.isSelfTargeting(project?.repoPath)) {
        throw new HttpError(
          409,
          'this project targets the workbench itself — an isolated worktree is required (skipWorktree refused)',
        );
      }
    }
    return svc.approveBrief(id, b.comment, { skipWorktree: Boolean(b.skipWorktree) });
  });
  action('reject-brief', (id, b) => svc.rejectBrief(id, requireComment(b)));
  action('approve-plan', (id, b) =>
    svc.approvePlan(id, b.comment, { skipE2e: Boolean(b.skipE2e) }),
  );
  action('reject-plan', (id, b) => svc.rejectPlan(id, requireComment(b)));
  action('review/complete', (id, b) => svc.humanReviewComplete(id, b.comment));
  action('review/bounce', (id, b) => {
    if (!isBounceTarget(b.target)) {
      throw new HttpError(400, 'target must be "implementation" or "discovery"');
    }
    return svc.humanReviewBounce(id, b.target, requireComment(b));
  });
  action('approve-delivery', (id, b) => svc.approveDelivery(id, b.comment));
  action('reject-delivery', (id, b) => svc.rejectDelivery(id, requireComment(b)));
  // Abandon a task from ANY non-terminal stage (the operator escape hatch). Stops
  // any in-flight agent run first. 409s an already-terminal task.
  action('abandon', (id, b) => svc.abandonTask(id, b.comment));

  // Error mapping: illegal transitions + stale writes -> 409, HttpError -> its
  // status, else 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof IllegalTransitionError || err instanceof StaleWriteError) {
      return res.status(409).json({ error: err.message });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    const message = err instanceof Error ? err.message : 'internal error';
    res.status(500).json({ error: message });
  });

  return app;
}

/** Detect the package manager from whichever lockfile is present (npm default). */
function detectPackageManager(repoPath: string): PackageManager {
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Read `<repoPath>/package.json` and map its scripts onto our build-command
 * fields. Any read/parse failure yields all-empty commands rather than throwing
 * — a repo without (or with a malformed) package.json simply has nothing to
 * suggest, which is a valid outcome, not an error.
 */
function detectProjectCommands(repoPath: string): DetectedCommands {
  let scripts: Record<string, unknown> | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.scripts === 'object') scripts = pkg.scripts;
  } catch {
    scripts = undefined;
  }
  return detectCommandsFromPackageJson(scripts, detectPackageManager(repoPath));
}
