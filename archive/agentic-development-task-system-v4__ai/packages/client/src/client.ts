/**
 * Thin typed client over the daemon HTTP API — the one place either the web app
 * or a Node CLI reaches the daemon. All lifecycle mutations are POSTs to action
 * endpoints; the daemon owns the rules.
 *
 * `createClient(baseUrl)` lets the same client serve both consumers: the browser
 * passes `''` (relative paths, same origin), a Node process passes the daemon's
 * absolute origin (e.g. http://127.0.0.1:4417). `fetch` is global in Node 18+
 * and the browser, so no HTTP dependency is needed.
 */
import type {
  Artifact,
  DetectedCommands,
  Project,
  QueueEntry,
  QueueSpec,
  Task,
  Worktree,
  WorktreeMode,
} from '@workbench/core';
import type {
  AgentQuestion,
  AgentQuestionAnswer,
  AgentRun,
  AgentRunEvent,
  DemoAsset,
  GitStatus,
  TaskDetail,
} from './types.js';

/** The shape returned by createClient — exported so consumers can type it. */
export type WorkbenchClient = ReturnType<typeof createClient>;

/** Read the shared-secret token from the environment when running under Node. */
function tokenFromEnv(): string | undefined {
  // `process` is undefined in the browser; guard so the same module loads there.
  return typeof process !== 'undefined' ? process.env?.WORKBENCH_TOKEN : undefined;
}

/**
 * Build a client bound to `baseUrl` (no trailing slash; '' for same-origin).
 * `fetchImpl` is injectable so tests can supply a fake without a live daemon.
 * `token` is the optional daemon shared secret (default: `WORKBENCH_TOKEN` env
 * under Node) — sent as a Bearer header on requests and as a `?token=` query
 * param on SSE URLs (EventSource can't set headers). When the daemon has no
 * token configured, leaving this undefined is correct.
 */
export function createClient(
  baseUrl = '',
  fetchImpl: typeof fetch = fetch,
  token: string | undefined = tokenFromEnv(),
) {
  const base = baseUrl.replace(/\/$/, '');

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(base + path, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        (json as { error?: string }).error ?? `${method} ${path} failed (${res.status})`,
      );
    }
    return json as T;
  }

  // SSE is consumed via EventSource, which can't set an Authorization header —
  // so the token rides as a query param on stream URLs instead. No-op when
  // there's no token.
  function withToken(url: string): string {
    if (!token) return url;
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }

  return {
    listProjects: () => req<Project[]>('GET', '/api/projects'),
    createProject: (p: Partial<Project>) => req<Project>('POST', '/api/projects', p),
    /** Inspect a repo's package.json and suggest build commands (empty if none). */
    detectCommands: (repoPath: string) =>
      req<DetectedCommands>('POST', '/api/projects/detect-commands', { repoPath }),

    listTasks: () => req<Task[]>('GET', '/api/tasks'),
    createTask: (t: {
      projectId: string;
      title: string;
      rawRequest: string;
      worktreeMode?: WorktreeMode;
    }) => req<Task>('POST', '/api/tasks', t),
    getTask: (id: string) => req<TaskDetail>('GET', `/api/tasks/${id}`),

    /* ---------- Task queue ---------- */
    /** All queue entries, ordered priority desc then enqueue time (scheduling order). */
    listQueue: () => req<QueueEntry[]>('GET', '/api/queue'),
    /**
     * Enqueue a task for the multi-task scheduler. `dependsOn` is one queue-entry
     * id, or a list of them, that must each reach `done` before this one runs
     * (fan-in); `priority` (higher first) breaks ties among eligible entries.
     */
    enqueueTask: (input: {
      taskId: string;
      dependsOn?: string | string[] | null;
      priority?: number;
    }) => req<QueueEntry>('POST', '/api/queue', input),

    /**
     * Bulk-create a whole DAG of tasks + queue entries in ONE transaction. Tasks
     * are keyed by a local alias; `dependsOn` references sibling keys. All-or-
     * nothing — a mid-batch failure leaves nothing behind.
     */
    createQueueDag: (spec: QueueSpec) =>
      req<{
        projectId: string;
        created: Array<{ key: string; taskId: string; queueEntry: QueueEntry }>;
      }>('POST', '/api/queue/dag', spec),

    getArtifact: (id: string) => req<Artifact & { body: string }>('GET', `/api/artifacts/${id}`),
    /** Edit an artifact's body (e.g. refine an agent-written brief/plan). */
    updateArtifact: (id: string, body: string) =>
      req<Artifact & { body: string }>('PATCH', `/api/artifacts/${id}`, { body }),

    /** Delete a task and all its children (server abandons the worktree first). */
    deleteTask: (id: string) => req<{ ok: true }>('DELETE', `/api/tasks/${id}`),

    /** Durable QA proof assets (videos/screenshots/traces) captured for a task. */
    listAssets: (taskId: string) =>
      req<{ assets: DemoAsset[] }>('GET', `/api/tasks/${taskId}/assets`),
    /** Same-origin URL that streams one demo-asset for inline `<img>`/`<video>`. */
    assetUrl: (taskId: string, filename: string) =>
      `${base}/api/tasks/${taskId}/assets/${encodeURIComponent(filename)}`,

    /** Generic lifecycle action POST. Returns the updated task. */
    action: (taskId: string, path: string, body?: unknown) =>
      req<Task>('POST', `/api/tasks/${taskId}/${path}`, body ?? {}),

    /* ---------- Worktree ---------- */
    createWorktree: (taskId: string) => req<Worktree>('POST', `/api/tasks/${taskId}/worktree`),
    worktreeStatus: (taskId: string) =>
      req<GitStatus>('GET', `/api/tasks/${taskId}/worktree/status`),
    worktreeDiff: (taskId: string) =>
      req<{ diff: string }>('GET', `/api/tasks/${taskId}/worktree/diff`),
    abandonWorktree: (taskId: string) =>
      req<Worktree>('POST', `/api/tasks/${taskId}/worktree/abandon`),
    preserveWorktree: (taskId: string) =>
      req<Worktree>('POST', `/api/tasks/${taskId}/worktree/preserve`),

    /* ---------- Agent runs ---------- */
    /** All of a task's agent runs, oldest-first (the newest drives the terminal). */
    listRuns: (taskId: string) =>
      req<{ runs: AgentRun[] }>('GET', `/api/tasks/${taskId}/agent/runs`),

    /** The task's current in-flight run (running | awaiting_input), or null. */
    getActiveRun: (taskId: string) =>
      req<{ run: AgentRun | null }>('GET', `/api/tasks/${taskId}/agent/runs/active`),

    /** Run record + its persisted events (non-streaming snapshot). */
    getRun: (taskId: string, runId: string) =>
      req<{ run: AgentRun; events: AgentRunEvent[] }>(
        'GET',
        `/api/tasks/${taskId}/agent/runs/${runId}`,
      ),

    /** Stop an in-flight run — kills its CLI subprocess and marks it failed. */
    stopRun: (taskId: string, runId: string) =>
      req<{ run: AgentRun }>('POST', `/api/tasks/${taskId}/agent/runs/${runId}/stop`),

    /** SSE URL for a run's live event stream (consumed via EventSource). */
    runEventsUrl: (taskId: string, runId: string) =>
      withToken(`${base}/api/tasks/${taskId}/agent/runs/${runId}/events`),

    /**
     * SSE URL for a task's state-change notifications (consumed via EventSource).
     * Each event signals "refetch this task" — it carries no payload.
     */
    taskEventsUrl: (taskId: string) => withToken(`${base}/api/tasks/${taskId}/events`),

    /* ---------- Mid-run questions ---------- */
    unansweredQuestions: (taskId: string) =>
      req<AgentQuestion[]>('GET', `/api/tasks/${taskId}/questions/unanswered`),
    answerQuestion: (taskId: string, questionId: string, answer: AgentQuestionAnswer) =>
      req<AgentQuestion>('POST', `/api/tasks/${taskId}/agent/questions/${questionId}/answer`, {
        answer,
      }),
  };
}
