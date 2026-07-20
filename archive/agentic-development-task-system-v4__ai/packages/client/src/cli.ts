/**
 * `wb` — a thin CLI over the daemon HTTP API, for driving the lifecycle without
 * the web UI. It uses the same typed @workbench/client the web app does.
 *
 *   wb projects                                  list projects
 *   wb project create --name N --repo P --branch B [--runtime mock|claude]
 *                       [--delivery create_pr|merge_to_master] [--test CMD] ...
 *   wb tasks                                     list tasks
 *   wb task create --project ID --title T --request R
 *   wb task show <id>                            stage/status + artifacts + diff stat
 *   wb task profile <id>                         per-stage profiling report (Markdown)
 *   wb task drive <id>                           clear each human gate until done
 *   wb queue                                     list the multi-task queue
 *   wb queue create <spec.json>                  bulk-create tasks + wire their DAG
 *
 * Base URL: --url, else WORKBENCH_URL, else http://127.0.0.1:4417.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  agentRunDurationMs,
  crossStageRepeatedReads,
  formatDuration,
  type ProfileEvent,
  planQueueSpec,
  profileStage,
  type QueueSpec,
  readPathsOf,
  type Stage,
  stageNeedsHumanApproval,
  stageRunDurationMs,
  taskElapsedMs,
} from '@workbench/core';
import { createClient } from './client.js';

const DEFAULT_URL = 'http://127.0.0.1:4417';

/** Minimal flag parser: collects `--key value` (and bare positionals). */
function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = 'true'; // boolean flag
        i += 1;
      } else {
        flags[key] = next;
        i += 2;
      }
    } else {
      positionals.push(a);
      i += 1;
    }
  }
  return { positionals, flags };
}

/** The action endpoint that clears each human-approval gate. */
const GATE_ACTION: Record<string, string> = {
  human_brief_approval: 'approve-brief',
  human_plan_approval: 'approve-plan',
  human_review: 'review/complete',
  human_delivery_approval: 'approve-delivery',
};

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function out(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const baseUrl = flags.url ?? process.env.WORKBENCH_URL ?? DEFAULT_URL;
  const api = createClient(baseUrl);
  const [group, sub, arg] = positionals;

  if (group === 'projects') {
    out(await api.listProjects());
    return;
  }

  if (group === 'project' && sub === 'create') {
    if (!flags.name || !flags.repo || !flags.branch) {
      die('project create requires --name, --repo and --branch');
    }
    out(
      await api.createProject({
        name: flags.name,
        repoPath: flags.repo,
        defaultBranch: flags.branch,
        ...(flags.runtime ? { agentRuntime: flags.runtime as 'mock' | 'claude' } : {}),
        ...(flags.delivery
          ? { deliveryPolicy: flags.delivery as 'create_pr' | 'merge_to_master' }
          : {}),
        ...(flags.test ? { testCommand: flags.test } : {}),
        ...(flags.lint ? { lintCommand: flags.lint } : {}),
        ...(flags.typecheck ? { typecheckCommand: flags.typecheck } : {}),
        ...(flags.e2e ? { e2eCommand: flags.e2e } : {}),
        ...(flags.dev ? { devCommand: flags.dev } : {}),
      }),
    );
    return;
  }

  if (group === 'tasks') {
    out(await api.listTasks());
    return;
  }

  if (group === 'task' && sub === 'create') {
    if (!flags.project || !flags.title || !flags.request) {
      die('task create requires --project, --title and --request');
    }
    out(
      await api.createTask({
        projectId: flags.project,
        title: flags.title,
        rawRequest: flags.request,
      }),
    );
    return;
  }

  if (group === 'task' && sub === 'show') {
    if (!arg) die('task show requires a task id');
    const detail = await api.getTask(arg);
    const elapsedMs = taskElapsedMs(detail.task);
    out({
      id: detail.task.id,
      title: detail.task.title,
      stage: detail.task.stage,
      status: detail.task.status,
      worktreeMode: detail.task.worktreeMode,
      selfTargeting: detail.selfTargeting,
      // Total wall-clock the task has been alive (to now if still active).
      elapsed: elapsedMs == null ? null : formatDuration(elapsedMs),
      // Per-stage wall-clock, oldest first. In-progress runs measure to now.
      stages: detail.stageRuns.map((r) => {
        const d = stageRunDurationMs(r);
        return {
          stage: r.stage,
          status: r.status,
          duration: d == null ? null : formatDuration(d),
        };
      }),
      // Per Claude session (AgentRun) wall-clock, oldest first. A running
      // session measures to now.
      sessions: detail.agentRuns.map((r) => {
        const d = agentRunDurationMs(r);
        return {
          id: r.id,
          stage: r.stage,
          status: r.status,
          duration: d == null ? null : formatDuration(d),
        };
      }),
      // ids included so `wb task artifact <id>` can fetch a body to read.
      artifacts: detail.artifacts.map((a) => ({ id: a.id, kind: a.kind, title: a.title })),
    });
    return;
  }

  if (group === 'task' && sub === 'profile') {
    if (!arg) die('task profile requires a task id');
    await profile(api, arg);
    return;
  }

  if (group === 'task' && sub === 'artifact') {
    if (!arg) die('task artifact requires an artifact id');
    const art = await api.getArtifact(arg);
    // Print the body verbatim (not JSON-wrapped) so it's readable as markdown.
    process.stdout.write(`${art.body}\n`);
    return;
  }

  if (group === 'task' && sub === 'diff') {
    if (!arg) die('task diff requires a task id');
    const { diff } = await api.worktreeDiff(arg);
    process.stdout.write(diff.endsWith('\n') ? diff : `${diff}\n`);
    return;
  }

  if (group === 'task' && sub === 'action') {
    if (!arg) die('task action requires a task id and an action');
    const actionName = positionals[3];
    if (!actionName) die('task action requires an action (e.g. approve-brief, review/bounce)');
    // Reject/bounce carry a comment; bounce also needs a target. The daemon
    // validates and 400s if a required field is missing.
    const body: Record<string, unknown> = {};
    if (flags.comment) body.comment = flags.comment;
    if (flags.target) body.target = flags.target;
    out(await api.action(arg, actionName, body));
    return;
  }

  if (group === 'task' && sub === 'drive') {
    if (!arg) die('task drive requires a task id');
    await drive(api, arg);
    return;
  }

  if (group === 'queue' && (sub === undefined || sub === 'list')) {
    out(await api.listQueue());
    return;
  }

  if (group === 'queue' && sub === 'create') {
    if (!arg) die('queue create requires a path to a spec .json file');
    await queueCreate(api, arg);
    return;
  }

  die(
    'usage: wb <projects | project create | tasks | task create | ' +
      'task show <id> | task profile <id> | task artifact <artifactId> | task diff <id> | ' +
      'task action <id> <action> [--comment C] [--target T] | task drive <id> | ' +
      'queue [list] | queue create <spec.json>>',
  );
}

const num = (v: number | null | undefined): string => (v == null ? '—' : v.toLocaleString('en-US'));
const ms = (v: number | null | undefined): string => (v == null ? '—' : formatDuration(v));
const ratio = (v: number | null | undefined): string => (v == null ? '—' : v.toFixed(2));

/**
 * Print the full profiling report for a task: the 5 already-tracked metrics
 * (token/cost/turns + duration, per AgentRun) plus the 6 derived from each run's
 * event stream (tool latency, tool-call volume/serialism, files-read/cmds/tests,
 * result bytes [proxy], repeated reads, retry/permission waits). Renders Markdown
 * to stdout so it can be piped to a file: `wb task profile <id> > report.md`.
 */
async function profile(api: ReturnType<typeof createClient>, taskId: string): Promise<void> {
  const detail = await api.getTask(taskId);
  const runs = [...detail.agentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  // Fetch each run's events once; reuse for per-stage profiles + cross-stage reads.
  const eventsByRun = new Map<string, ProfileEvent[]>();
  for (const r of runs) {
    const { events } = await api.getRun(taskId, r.id);
    eventsByRun.set(r.id, events as ProfileEvent[]);
  }

  const W = process.stdout.write.bind(process.stdout);
  W(`# Profiling report — ${detail.task.title}\n\n`);
  W(`- Task: \`${detail.task.id}\` (${detail.task.stage} / ${detail.task.status})\n`);
  W(
    `- Project: ${detail.project?.name ?? '—'} (runtime: ${detail.project?.agentRuntime ?? '—'})\n`,
  );
  W(`- Agent runs: ${runs.length}\n\n`);

  // True model-API latency: prefer the persisted row column (no event replay),
  // fall back to the run's `cost` event for legacy rows that predate the column.
  const apiLatencyMsOf = (run: (typeof runs)[number]): number | null => {
    if (typeof run.durationApiMs === 'number') return run.durationApiMs;
    for (const e of eventsByRun.get(run.id) ?? []) {
      if (e.type !== 'cost') continue;
      const v = (e.payload as { durationApiMs?: unknown } | null)?.durationApiMs;
      if (typeof v === 'number') return v;
    }
    return null;
  };

  // ---- The existing 5 metrics: token/cost/turns + duration, per AgentRun ----
  W(`## Tokens, cost & duration (per session)\n\n`);
  W(`| Stage | Dur | API lat | TTFT | In | Out | Cache wr | Cache rd | Turns | Cost |\n`);
  W(`|---|---|--:|--:|--:|--:|--:|--:|--:|--:|\n`);
  for (const r of runs) {
    const cost = r.totalCostUsd == null ? '—' : `$${r.totalCostUsd.toFixed(4)}`;
    const apiLat = apiLatencyMsOf(r);
    W(
      `| ${r.stage} | ${ms(agentRunDurationMs(r))} | ${ms(apiLat)} | ${ms(r.ttftMs)} | ${num(r.inputTokens)} | ${num(r.outputTokens)} | ${num(r.cacheCreationInputTokens)} | ${num(r.cacheReadInputTokens)} | ${num(r.numTurns)} | ${cost} |\n`,
    );
  }

  // ---- The 6 new metrics, per stage, derived from the event stream ----
  W(`\n## Tool activity & efficiency (per stage)\n\n`);
  W(
    `| Stage | Calls | Batch ratio | Reads (uniq) | Cmds | Tests | Writes | Work ratio | Slowest tool |\n`,
  );
  W(`|---|--:|--:|--:|--:|--:|--:|--:|---|\n`);
  for (const r of runs) {
    const p = profileStage(r.stage, eventsByRun.get(r.id) ?? []);
    const slow = p.toolLatency.slowest[0];
    const slowStr = slow ? `${slow.name} ${ms(slow.latencyMs)}` : '—';
    W(
      `| ${r.stage} | ${p.volume.toolCalls} | ${ratio(p.volume.batchingRatio)} | ${p.activity.filesRead} (${p.activity.distinctFilesRead}) | ${p.activity.commandsRun} | ${p.activity.testsRun} | ${p.activity.filesWritten} | ${ratio(p.activity.workRatio)} | ${slowStr} |\n`,
    );
  }

  // ---- Waste signals: repeated reads, retries, denials, big results ----
  W(`\n## Waste signals (per stage)\n\n`);
  W(`| Stage | Repeated reads | Retries | Denials | Errored calls | Largest result |\n`);
  W(`|---|---|--:|---|--:|---|\n`);
  for (const r of runs) {
    const p = profileStage(r.stage, eventsByRun.get(r.id) ?? []);
    const reps =
      p.repeatedReads.length === 0
        ? '—'
        : p.repeatedReads.map((x) => `${x.path.split('/').pop()}×${x.times}`).join(', ');
    const denials = p.waits.permissionDenials.length ? p.waits.permissionDenials.join(',') : '—';
    const big = p.resultBytes.largest
      ? `${p.resultBytes.largest.name} ${num(p.resultBytes.largest.chars)}ch`
      : '—';
    W(
      `| ${r.stage} | ${reps} | ${p.waits.retries} | ${denials} | ${p.waits.erroredCalls} | ${big} |\n`,
    );
  }

  // ---- Cross-stage repeated reads: the "missing working memory" signal ----
  const perStageReads = runs.map((r) => ({
    stage: r.stage,
    readPaths: readPathsOf(eventsByRun.get(r.id) ?? []),
  }));
  // ---- Inter-event gaps: model/transit wait vs daemon persist delay ----
  W(`\n## Inter-event gaps (per stage)\n\n`);
  W(`| Stage | Max gap | Median gap | Max persist | Slowest boundary |\n`);
  W(`|---|--:|--:|--:|---|\n`);
  for (const r of runs) {
    const p = profileStage(r.stage, eventsByRun.get(r.id) ?? []);
    const top = p.gaps.slowest[0];
    const slowStr = top ? `${top.boundary} ${ms(top.modelMs)}` : '—';
    W(
      `| ${r.stage} | ${ms(p.gaps.modelGap.maxMs)} | ${ms(p.gaps.modelGap.medianMs)} | ${ms(p.gaps.persistGap.maxMs)} | ${slowStr} |\n`,
    );
  }

  const cross = crossStageRepeatedReads(perStageReads);
  W(`\n## Cross-stage repeated reads (missing working-memory signal)\n\n`);
  if (cross.length === 0) {
    W(`_None — no file was read in more than one stage._\n`);
  } else {
    W(`| File | Stages that re-read it |\n|---|---|\n`);
    for (const c of cross) W(`| ${c.path} | ${c.stages.join(' → ')} |\n`);
  }
  W(
    `\n_Result bytes are a lower-bound proxy (truncated summaries). Batch ratio: 1.0 = fully serial. Work ratio = writes ÷ calls. Gaps: model = idle wait between events (adapter/model/tool); persist = daemon receive→insert delay. TTFT = first-turn time-to-first-token._\n`,
  );
}

/**
 * Drive a task to a terminal state by clearing each human gate it parks at.
 * Each approval auto-advances the non-gate stages server-side; we re-fetch and
 * approve the next gate. Stops if the task stops advancing (e.g. parked on a
 * failed validation) so the loop can't spin forever.
 */
async function drive(api: ReturnType<typeof createClient>, taskId: string): Promise<void> {
  // The very first move out of intake is generate-brief (the only non-gate
  // action still driven manually); everything after is gate approvals.
  let task = await api.getTask(taskId).then((d) => d.task);
  if (task.stage === 'intake' || task.stage === 'task_brief') {
    task = await api.action(taskId, 'generate-brief');
    process.stdout.write(`generate-brief -> ${task.stage}/${task.status}\n`);
  }

  // Clear gates until terminal, bailing if a step doesn't change the stage.
  for (let guard = 0; guard < 32; guard++) {
    if (task.status === 'done' || task.status === 'abandoned') {
      process.stdout.write(`done: ${task.stage}/${task.status}\n`);
      return;
    }
    if (!stageNeedsHumanApproval(task.stage as Stage)) {
      die(`task parked at non-gate stage ${task.stage}/${task.status} — cannot auto-advance`);
    }
    const action = GATE_ACTION[task.stage];
    if (!action) die(`no gate action mapped for stage ${task.stage}`);

    const before = task.stage;
    try {
      task = await api.action(taskId, action);
    } catch (err) {
      die(`${action} failed: ${(err as Error).message}`);
    }
    process.stdout.write(`${action} -> ${task.stage}/${task.status}\n`);
    if (task.stage === before && task.status === 'active') {
      die(`gate ${action} did not advance the task (still ${before}) — stopping`);
    }
  }
  die('drive exceeded 32 steps without reaching a terminal state — stopping');
}

/**
 * Bulk-create tasks from a JSON spec and wire their dependency DAG. Validates the
 * whole spec client-side (fast local error), then hands it to the daemon which
 * creates every task + queue entry + edge in ONE transaction — so a mid-batch
 * failure leaves nothing behind (all-or-nothing).
 */
async function queueCreate(api: ReturnType<typeof createClient>, specPath: string): Promise<void> {
  let spec: QueueSpec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8')) as QueueSpec;
  } catch (err) {
    die(`could not read/parse spec ${specPath}: ${(err as Error).message}`);
  }
  try {
    planQueueSpec(spec); // fail fast locally before the round-trip
  } catch (err) {
    die((err as Error).message);
  }
  out(await api.createQueueDag(spec));
}

// Only run the CLI when executed directly, not when imported (e.g. by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die((err as Error).message));
}
