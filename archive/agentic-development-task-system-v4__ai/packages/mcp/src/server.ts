/**
 * Workbench MCP server — exposes the daemon's HTTP API as MCP tools so a local
 * Claude session (or the demo driver) can create and steer tasks natively.
 *
 * This is a THIN wrapper: every tool delegates to a `@workbench/client` method
 * (the same typed client the web app and `wb` CLI use). The only non-trivial
 * logic is `wait_for_run`, which lives in ./wait.ts.
 *
 * Transport is stdio. Base URL comes from WORKBENCH_URL (default the daemon's
 * conventional http://127.0.0.1:4417); the demo points it at its throwaway daemon.
 *
 * All tools (read + action) are exposed unconditionally — this is a single-user
 * local tool, so there is no capability gate. A local session can create/drive/
 * abandon real tasks.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient, type WorkbenchClient } from '@workbench/client';
import {
  AGENT_RUNTIMES,
  DELIVERY_POLICIES,
  LIFECYCLE_ACTIONS,
  WORKTREE_MODES,
} from '@workbench/core';
import { z } from 'zod';
import { waitForRun } from './wait.js';

const DEFAULT_URL = 'http://127.0.0.1:4417';

/** Wrap any value as a single text-content result (JSON-stringified if not a string). */
function ok(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

/** Surface a thrown error as an MCP error result rather than crashing the server. */
function fail(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true as const,
  };
}

/** Run an async client call, mapping success/failure to MCP result shapes. */
async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

/**
 * Build a configured MCP server bound to `client`. Exported (and client-injected)
 * so unit tests can register tools against a fake client and invoke handlers.
 */
/**
 * Server-level guidance handed to the tool-using agent as a preamble (MCP
 * `instructions`). The MCP equivalent of a CLAUDE.md: it tells the agent how to
 * drive a task before it has read any code. Keep it terse and behavioral.
 */
const SERVER_INSTRUCTIONS = `Workbench drives dev tasks through a human-gated lifecycle. Stages (packages/core lifecycle):
intake → task_brief → [human_brief_approval] → discovery → [human_plan_approval] → implementation →
static_checks → feature_e2e → agent_self_review → [human_review] → delivery_prep →
[human_delivery_approval] → publish → closeout. The four [bracketed] stages are human gates; every other
stage auto-advances server-side. Worktree creation is NOT a stage — it is a side-effect of approve-brief.

To run a task: create_task, then do_action(generate-brief) to reach the first gate. At each gate READ the
relevant artifact before deciding — call get_task (returns the full bundle incl. artifact ids), then
get_artifact(id); at human_review also read worktree_diff. Then do_action to approve
(approve-brief | approve-plan | review/complete | approve-delivery) or bounce (reject-* / review/bounce
with a required comment — the comment is the only feedback the regenerated artifact gets).

To run MANY tasks: prefer create_queue_dag (one atomic transaction) over looping create_task + enqueue_task.
A dependent runs only once EVERY predecessor reaches the terminal 'done' — depend only on tasks you expect
to complete, or the dependent waits forever.

Mid-run, a claude-runtime agent may pause with a question; a gate stays blocked (409) until answered — poll
unanswered_questions and reply with answer_question. To wait on an in-flight run, use wait_for_run.
Never bypass a gate; the daemon enforces every legal move regardless of caller.`;

export function buildServer(client: WorkbenchClient): McpServer {
  const server = new McpServer(
    { name: 'workbench', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /* ---------- Projects ---------- */
  server.registerTool(
    'list_projects',
    { description: 'List all registered projects.', inputSchema: {} },
    () => run(() => client.listProjects()),
  );
  server.registerTool(
    'create_project',
    {
      description: 'Register a new project.',
      inputSchema: {
        name: z.string(),
        repoPath: z.string(),
        // Required by the daemon (POST /api/projects -> 400 without it).
        defaultBranch: z.string(),
        description: z.string().optional(),
        agentRuntime: z.enum(AGENT_RUNTIMES).optional(),
        deliveryPolicy: z.enum(DELIVERY_POLICIES).optional(),
        // Per-project runtime tuning (model / self-hosted endpoint / binary override).
        runtimeConfig: z
          .object({
            model: z.string().optional(),
            baseUrl: z.string().optional(),
            binary: z.string().optional(),
          })
          .optional(),
        testCommand: z.string().optional(),
        lintCommand: z.string().optional(),
        typecheckCommand: z.string().optional(),
        e2eCommand: z.string().optional(),
        devCommand: z.string().optional(),
      },
    },
    (args) => run(() => client.createProject(args)),
  );

  /* ---------- Tasks ---------- */
  server.registerTool('list_tasks', { description: 'List all tasks.', inputSchema: {} }, () =>
    run(() => client.listTasks()),
  );
  server.registerTool(
    'create_task',
    {
      description: 'Create a task under a project.',
      inputSchema: {
        projectId: z.string(),
        title: z.string(),
        rawRequest: z.string(),
        // 'worktree' (default) isolates the work; 'direct' commits on the checkout.
        worktreeMode: z.enum(WORKTREE_MODES).optional(),
      },
    },
    (args) => run(() => client.createTask(args)),
  );
  server.registerTool(
    'get_task',
    {
      description:
        'Get a task with its full bundle (project, stageRuns, artifacts, approvals, worktree, delivery, agentRuns).',
      inputSchema: { taskId: z.string() },
    },
    ({ taskId }) => run(() => client.getTask(taskId)),
  );
  server.registerTool(
    'abandon_task',
    {
      description: 'Delete a task and all its children (worktree abandoned first).',
      inputSchema: { taskId: z.string() },
    },
    ({ taskId }) => run(() => client.deleteTask(taskId)),
  );

  /* ---------- Task queue ---------- */
  server.registerTool(
    'list_queue',
    {
      description:
        'List the multi-task queue, ordered priority desc then enqueue time. Each entry has status (queued|running|done|failed), priority, and dependsOnIds (the queue entries it waits on).',
      inputSchema: {},
    },
    () => run(() => client.listQueue()),
  );
  server.registerTool(
    'enqueue_task',
    {
      description:
        "Enqueue a task for the scheduler under a dependency DAG. `dependsOn` is one queue-entry id, or an array of them, that must EACH reach `done` before this one runs (fan-in); `priority` (higher first) breaks ties among eligible entries. Returns the created queue entry (use its id in a later task's `dependsOn`). Only a predecessor reaching `done` unblocks a dependent — if a predecessor is abandoned or its driver errors (entry goes `failed`), the dependent stays `queued` forever, so only depend on tasks you expect to complete. Entries with no unmet dependency run in parallel.",
      inputSchema: {
        taskId: z.string(),
        dependsOn: z.union([z.string(), z.array(z.string())]).optional(),
        priority: z.number().optional(),
      },
    },
    ({ taskId, dependsOn, priority }) =>
      run(() => client.enqueueTask({ taskId, dependsOn, priority })),
  );
  server.registerTool(
    'create_queue_dag',
    {
      description:
        'Create a whole dependency DAG of tasks in ONE atomic step: creates every task + its queue entry + edges in a single transaction (a mid-batch failure leaves NOTHING behind). Each task carries a local `key`; `dependsOn` references sibling keys (a key, or an array of keys, that must each reach `done` first — fan-in). The spec is validated (unique keys, known refs, acyclic) before anything is written. Prefer this over looping create_task + enqueue_task when building a multi-task DAG. Returns the created tasks with their queue-entry ids.',
      inputSchema: {
        projectId: z.string(),
        tasks: z
          .array(
            z.object({
              key: z.string(),
              title: z.string(),
              request: z.string(),
              dependsOn: z.union([z.string(), z.array(z.string())]).optional(),
              priority: z.number().optional(),
            }),
          )
          .min(1),
      },
    },
    (spec) => run(() => client.createQueueDag(spec)),
  );

  /* ---------- Artifacts ---------- */
  server.registerTool(
    'get_artifact',
    {
      description: "Fetch an artifact's metadata and full body.",
      inputSchema: { artifactId: z.string() },
    },
    ({ artifactId }) => run(() => client.getArtifact(artifactId)),
  );

  /* ---------- Lifecycle actions ---------- */
  server.registerTool(
    'do_action',
    {
      description:
        'Fire a lifecycle action on a task (e.g. generate-brief, approve-brief, reject-brief, approve-plan, reject-plan, review/complete, review/bounce, approve-delivery, reject-delivery, abandon). Optional comment/target passed through to the daemon.',
      inputSchema: {
        taskId: z.string(),
        action: z.enum(LIFECYCLE_ACTIONS),
        comment: z.string().optional(),
        target: z.string().optional(),
      },
    },
    ({ taskId, action, comment, target }) =>
      run(() => client.action(taskId, action, { comment, target })),
  );

  /* ---------- Worktree ---------- */
  server.registerTool(
    'worktree_diff',
    {
      description: "Get the task worktree's git diff.",
      inputSchema: { taskId: z.string() },
    },
    ({ taskId }) => run(() => client.worktreeDiff(taskId)),
  );

  /* ---------- Agent runs ---------- */
  server.registerTool(
    'get_active_run',
    {
      description: "Get the task's current in-flight agent run, or null.",
      inputSchema: { taskId: z.string() },
    },
    ({ taskId }) => run(() => client.getActiveRun(taskId)),
  );
  server.registerTool(
    'get_run',
    {
      description: 'Get an agent run record plus its persisted events (non-streaming snapshot).',
      inputSchema: { taskId: z.string(), runId: z.string() },
    },
    ({ taskId, runId }) => run(() => client.getRun(taskId, runId)),
  );
  server.registerTool(
    'wait_for_run',
    {
      description:
        "Block until the task's in-flight agent run finishes (rides the daemon SSE stream). Returns { outcome: 'finished' | 'idle' | 'fallback' }; 'fallback' means SSE was unavailable and the caller should poll get_task.",
      inputSchema: {
        taskId: z.string(),
        timeoutMs: z.number().optional(),
      },
    },
    ({ taskId, timeoutMs }) =>
      run(async () => ({ outcome: await waitForRun(client, taskId, { timeoutMs }) })),
  );

  /* ---------- Mid-run questions ---------- */
  server.registerTool(
    'unanswered_questions',
    {
      description: "List the task's unanswered mid-run agent questions (permission/input gates).",
      inputSchema: { taskId: z.string() },
    },
    ({ taskId }) => run(() => client.unansweredQuestions(taskId)),
  );
  server.registerTool(
    'answer_question',
    {
      description:
        'Answer a mid-run agent question: pass `selected` (option labels chosen) for a choice question, or `text` for a free-text answer.',
      inputSchema: {
        taskId: z.string(),
        questionId: z.string(),
        selected: z.array(z.string()).optional(),
        text: z.string().optional(),
      },
    },
    ({ taskId, questionId, selected, text }) =>
      run(() => {
        const answer = text !== undefined ? { text } : { selected: selected ?? [] };
        return client.answerQuestion(taskId, questionId, answer);
      }),
  );

  return server;
}

async function main() {
  const baseUrl = process.env.WORKBENCH_URL ?? DEFAULT_URL;
  const server = buildServer(createClient(baseUrl));
  await server.connect(new StdioServerTransport());
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
