import { ClaudeAgentRuntimeAdapter, createAgentAdapter } from '@workbench/agents';
import type { AgentRun } from '@workbench/core';
import { Store } from '@workbench/store';
import { GitWorktreeProvider } from '@workbench/worktree';
import { createApp } from './app.js';
import { reapOrphanProcessGroups } from './boot-reconcile.js';
import { logger } from './logger.js';
import { ARTIFACTS_DIR, DB_PATH, PORT, PROJECT_MEMORY_DIR, WORKTREES_DIR } from './paths.js';
import { ensureEnterpriseProjects } from './seed-enterprise.js';

// Last-resort safety net. Detached agent runs are guarded at the source
// (AgentRunExecutor.start swallows their rejections), but a stray unhandled
// rejection ANYWHERE must not take down the daemon that's serving every task —
// Node ≥15 aborts the process by default when nothing handles one. Log loudly
// and keep running; a single run's failure is already recorded on its row.
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason.message : String(reason) },
    'unhandledRejection (kept alive)',
  );
});

const store = new Store({
  dbPath: DB_PATH,
  artifactsDir: ARTIFACTS_DIR,
  projectMemoryDir: PROJECT_MEMORY_DIR,
});

// Always keep the two Klaviyo enterprise projects (app, fender) registered with the
// correct delivery policy (draft PR, never merge to default). Idempotent by repoPath:
// creates missing ones and corrects a drifted policy back to create_pr.
const { created, corrected } = ensureEnterpriseProjects(store);
if (created > 0 || corrected > 0) {
  logger.info({ created, corrected }, 'ensured enterprise project(s)');
}

// Boot reconciliation, step 1: any run left `running`/`awaiting_input` by a
// prior process is an orphan (its in-memory state is gone). Mark them
// `interrupted` and capture the rows so we can reap their process groups and
// resume their conversations below.
const interrupted = store.markInterruptedRuns();
if (interrupted.length > 0) {
  logger.warn({ count: interrupted.length }, 'marked orphaned agent run(s) -> interrupted');
}

// The claude adapter shells out to the local `claude` CLI (using the user's
// existing login — no API key). Overridable for non-standard installs/models.
const claudeAdapter = new ClaudeAgentRuntimeAdapter({
  bin: process.env.WORKBENCH_CLAUDE_BIN || 'claude',
  model: process.env.WORKBENCH_CLAUDE_MODEL || undefined,
  // Stall watchdog override (ms). Unset -> adapter default; 0 disables.
  stallTimeoutMs: process.env.WORKBENCH_STALL_TIMEOUT_MS
    ? Number(process.env.WORKBENCH_STALL_TIMEOUT_MS)
    : undefined,
  // Per-stage turn budget override. Unset -> adapter default.
  maxTurns: process.env.WORKBENCH_MAX_TURNS ? Number(process.env.WORKBENCH_MAX_TURNS) : undefined,
});

// Boot handles bound to the service, captured from createApp's onReady so we can
// run reconciliation after listen (resume) and before it (reap orphan groups).
let boot: {
  resumeInterruptedTasks: () => Promise<{ resumed: number; skipped: number }>;
  worktreePathForRun: (run: AgentRun) => string | undefined;
  resumeQueue: () => Promise<void>;
} | null = null;

const app = createApp(store, {
  worktrees: new GitWorktreeProvider(),
  worktreesDir: WORKTREES_DIR,
  // Per-project runtime: mock returns canned content; claude/pi run their CLI
  // confined to the task worktree. The Claude adapter is pre-built (its MCP-server
  // reader + turn/stall config) and substituted via deps; pi (and any other
  // runtime) is built by its profile from the project's runtime config.
  agentFor: (runtime, config) => createAgentAdapter(runtime, config, { claude: claudeAdapter }),
  // The spawned MCP gate server relays mid-run questions back to this daemon.
  daemonUrl: `http://127.0.0.1:${PORT}`,
  onReady: ({ resumeInterruptedTasks, worktreePathForRun, resumeQueue }) => {
    boot = { resumeInterruptedTasks, worktreePathForRun, resumeQueue };
  },
});

// Boot reconciliation, step 2: reap the process group of every interrupted run
// whose group is still alive AND verifiably ours (the claude tree, incl. its MCP
// ask-server child). Runs BEFORE listen so we don't resume a task whose orphan is
// still mutating its worktree. Best-effort; never kills an unverified pid.
const reaped = reapOrphanProcessGroups(interrupted, (run) => boot?.worktreePathForRun(run));
if (reaped.killed > 0 || reaped.skipped > 0) {
  logger.warn(reaped, 'orphan reap summary (killed/stale/skipped process groups)');
}

// Bind loopback by default — the daemon owns every side effect (git, shell,
// edits, gh push under the operator's credentials) and has no multi-user model,
// so it must not be reachable from the network. WORKBENCH_HOST overrides only
// for a deliberate, trusted deployment (e.g. a container that fronts it with
// real auth); pair it with WORKBENCH_TOKEN (see app.ts) when you do.
const HOST = process.env.WORKBENCH_HOST ?? '127.0.0.1';

app.listen(PORT, HOST, () => {
  logger.info(
    {
      url: `http://${HOST}:${PORT}`,
      db: DB_PATH,
      worktrees: WORKTREES_DIR,
      authEnabled: Boolean(process.env.WORKBENCH_TOKEN),
    },
    'daemon listening',
  );

  // Boot reconciliation, step 3: resume the conversations behind interrupted
  // runs. Detached + off the listen path so slow agent work never blocks the
  // HTTP edge coming up; the unhandledRejection net above keeps a failure from
  // taking down the daemon. No-op when nothing was interrupted.
  if (interrupted.length > 0) {
    void boot
      ?.resumeInterruptedTasks()
      .then((r) => logger.info(r, 'boot-resume summary (resumed/skipped tasks)'))
      .catch((err) =>
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'boot-resume batch failed',
        ),
      );
  }

  // Boot reconciliation, step 4: re-scan the task queue. The QueueService starts
  // event-driven when the app is built, but it should re-tick AFTER interrupted
  // tasks are re-driven — a predecessor that completes during resume unblocks its
  // queued dependents. Detached + isolated like the resume batch above.
  void boot
    ?.resumeQueue()
    .catch((err) =>
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'queue resume tick failed',
      ),
    );
});
