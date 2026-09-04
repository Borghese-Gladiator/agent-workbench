import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { daemonClient, daemonBaseUrl, DaemonRequestError } from '../daemon-client.js';
import { rememberTaskId, resolveRepositoryId, resolveTaskId } from '../remembered.js';
import { resolveRepoRef } from './repo.js';
import { emitJson, outputOptions, printError, printInfo, printResult } from '../output.js';
import { parseDuration, formatDuration } from '../duration.js';
import { formatColumns } from '../table.js';
import { uiPort } from '../services.js';

interface CreatedTask {
  taskId: string;
  workflowId: string;
  repositoryId: string;
}

interface TaskListItem {
  taskId: string;
  repositoryId: string;
  workflowId: string;
  prompt: string;
  createdAt: string;
}

export interface TimelineResponse {
  taskId: string;
  phases: Array<{
    phaseAttemptId: string;
    phase: string;
    attemptNumber: number;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    outcome: string | null;
    runtimeAttribution: Record<string, number | string> | null;
    sessions: Array<{ id: string; role: string; runtime: string; model: string | null; durationMs: number | null }>;
    qa: Array<{ id: string; kind: string; status: string; summary: string }>;
    evidence: Array<{ id: string; kind: string; status: string; summary: string }>;
    artifacts: Array<{ id: string; kind: string; mediaType: string; byteSize: number }>;
  }>;
  totals: {
    durationMs: number;
    openAttempts: number;
    qaExecutionMs: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number;
  };
  longestPhase: { phase: string; attemptNumber: number; durationMs: number } | null;
}

interface PruneResponse {
  dryRun: boolean;
  pruned: number;
  tasks: { taskId: string; repositoryId: string; condition: string; updatedAt: string }[];
}

interface TaskShowResponse {
  state: { phase: string; condition: string; deliveryState: string };
  openFindings: string[];
  pendingHumanGate?: { reason: string } | null;
}

/**
 * Cheap, model-free readable title for a task, derived from its prompt (TASK-103). Collapses
 * whitespace, takes the first sentence (up to a `.`/`!`/`?` followed by a space or end), drops a lone
 * trailing sentence terminator, and truncates to `maxLength` with an ellipsis. No DB change: this is
 * computed client-side from the stored prompt so the CLI list/show stay scannable.
 */
export function deriveTaskTitle(prompt: string, maxLength = 72): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '(no prompt)';
  const match = collapsed.match(/^.*?[.!?](?:\s|$)/);
  let title = (match ? match[0] : collapsed).trim();
  title = title.replace(/[.!?]+$/, '').trim();
  if (title.length > maxLength) {
    title = `${title.slice(0, maxLength - 1).trimEnd()}…`;
  }
  return title === '' ? '(no prompt)' : title;
}

/**
 * The run id for a task. A task has exactly one run and `semantic_events.run_id` carries this
 * suffixed form, so a query by bare task id matches nothing — that was why `task logs` reported no
 * events for tasks that had thousands. Mirrors `runIdForTask` in `@awb/database`, which the CLI does
 * not depend on.
 */
export function runIdForTaskId(taskId: string): string {
  return `${taskId}-run`;
}

/**
 * The catch-up query `task logs` reads a task's events from. `afterSequence` is EXCLUSIVE and
 * sequences start at 0, so the previous `afterSequence=0` silently dropped the first event of every
 * run; -1 is the route's own "everything" value.
 */
export function eventsQueryFor(taskId: string): string {
  return `/api/events?runId=${encodeURIComponent(runIdForTaskId(taskId))}&afterSequence=-1`;
}

/** The 12 runtime-attribution buckets, in the order the timeline reports them. */
const ATTRIBUTION_BUCKETS = [
  ['modelGenerationMs', 'model'],
  ['toolExecutionMs', 'tools'],
  ['testExecutionMs', 'tests'],
  ['qaExecutionMs', 'qa'],
  ['dependencyInstallMs', 'deps'],
  ['environmentSetupMs', 'env'],
  ['serviceStartupMs', 'services'],
  ['githubOperationMs', 'github'],
  ['artifactProcessingMs', 'artifacts'],
  ['modelWaitMs', 'model-wait'],
  ['humanWaitMs', 'human-wait'],
  ['retryBackoffMs', 'backoff'],
] as const;

/** The non-zero runtime-attribution buckets as `label duration` pairs, biggest first. */
export function formatAttribution(attribution: Record<string, number | string> | null): string {
  if (!attribution) return '';
  const parts = ATTRIBUTION_BUCKETS.map(([key, label]) => {
    const value = attribution[key];
    return { label, ms: typeof value === 'number' ? value : 0 };
  })
    .filter((p) => p.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .map((p) => `${p.label} ${formatDuration(p.ms)}`);
  return parts.join('  ');
}

/** The indented detail lines under one phase row: where the time went, sessions, QA, outputs. */
function phaseDetails(phase: TimelineResponse['phases'][number]): string[] {
  const details: string[] = [];
  const attribution = formatAttribution(phase.runtimeAttribution);
  if (attribution !== '') details.push(`where: ${attribution}`);
  for (const session of phase.sessions) {
    details.push(
      `session ${session.role} (${session.model ?? session.runtime}) ${formatDuration(session.durationMs)}`,
    );
  }
  for (const qa of phase.qa) {
    details.push(`qa ${qa.kind}: ${qa.status} — ${qa.summary}`);
  }
  if (phase.evidence.length > 0) {
    const passed = phase.evidence.filter((e) => e.status === 'passed').length;
    details.push(
      `evidence ${phase.evidence.length} (${passed} passed), artifacts ${phase.artifacts.length}`,
    );
  } else if (phase.artifacts.length > 0) {
    details.push(`artifacts ${phase.artifacts.length}`);
  }
  return details;
}

/** Renders the timeline as plain text. Returns the lines so a test can assert on them. */
export function renderTimeline(timeline: TimelineResponse): string[] {
  const lines: string[] = [];
  lines.push(`Task ${timeline.taskId} — ${timeline.phases.length} phase attempts`);
  if (timeline.longestPhase) {
    const longest = timeline.longestPhase;
    lines.push(
      `Longest phase: ${longest.phase} #${longest.attemptNumber} (${formatDuration(longest.durationMs)})`,
    );
  }
  lines.push('');

  const [header, ...rows] = formatColumns(
    ['PHASE', 'DURATION', 'OUTCOME'],
    timeline.phases.map((p) => [
      `${p.phase} #${p.attemptNumber}`,
      formatDuration(p.durationMs),
      p.outcome ?? '(open)',
    ]),
  );
  lines.push(header!);
  rows.forEach((row, i) => {
    lines.push(row);
    for (const detail of phaseDetails(timeline.phases[i]!)) lines.push(`  ${detail}`);
  });

  lines.push('');
  const t = timeline.totals;
  const openNote = t.openAttempts > 0 ? ` (${t.openAttempts} attempts still open)` : '';
  lines.push(`Total wall-clock: ${formatDuration(t.durationMs)}${openNote}`);
  lines.push(`QA execution: ${formatDuration(t.qaExecutionMs)}`);
  lines.push(
    `Tokens: ${t.inputTokens} in / ${t.outputTokens} out (cache read ${t.cachedInputTokens}, cache write ${t.cacheCreationInputTokens})`,
  );
  lines.push(`Cost: $${t.costUsd.toFixed(4)}`);
  return lines;
}

const TERMINAL_CONDITIONS = new Set(['completed', 'failed', 'cancelled']);
// Conditions where the task will not progress without a human/external action — `wait` should
// return control to the caller rather than block forever.
const HALTED_CONDITIONS = new Set(['awaiting-human', 'awaiting-external', 'blocked']);

function handleError(err: unknown): void {
  if (err instanceof DaemonRequestError) printError(err.message);
  else printError(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

function readPromptFrom(promptArg: string | undefined, promptFile: string | undefined): string {
  if (promptFile !== undefined) {
    const raw = promptFile === '-' ? readFileSync(0, 'utf8') : readFileSync(promptFile, 'utf8');
    return raw.trim();
  }
  if (promptArg !== undefined) return promptArg;
  throw new Error('Provide a prompt as an argument or via --prompt-file.');
}

function normalizeSize(size: string | undefined): 'S' | 'M' | 'L' | undefined {
  if (size === undefined) return undefined;
  const upper = size.toUpperCase();
  if (upper === 'S' || upper === 'M' || upper === 'L') return upper;
  throw new Error(`Invalid --size "${size}": expected S, M, or L.`);
}

async function resolveRepo(repoOpt: string | undefined, fallback: string | undefined): Promise<string> {
  if (repoOpt !== undefined) return resolveRepoRef(repoOpt);
  return resolveRepositoryId(fallback);
}

export function registerTaskCommands(program: Command): void {
  const task = program.command('task').description('Create, monitor, and control tasks');

  task
    .command('create [prompt]')
    .description('Create (and schedule) a task against a registered repository')
    .option('--repo <repo>', 'Repository path or id (defaults to the last one used)')
    .option('--prompt <prompt>', 'Task prompt (alternative to the positional argument)')
    .option('--prompt-file <path>', 'Read the prompt from a file, or "-" for stdin')
    .option('--size <size>', 'Task size hint: S, M, or L (the classifier still decides; overridable at the gate)')
    .option('--parent-task <id>', 'Stack this task on a parent task: base its branch + PR on the parent\'s delivered branch (TASK-72)')
    .option('--base-branch <ref>', 'Explicit base branch to branch from and open the PR against (overrides --parent-task resolution)')
    .action(
      async (
        promptArg: string | undefined,
        opts: { repo?: string; prompt?: string; promptFile?: string; size?: string; parentTask?: string; baseBranch?: string },
      ) => {
        try {
          const repoId = await resolveRepo(opts.repo, undefined);
          const prompt = readPromptFrom(opts.prompt ?? promptArg, opts.promptFile);
          const size = normalizeSize(opts.size);
          const result = await daemonClient.post<CreatedTask>('/api/tasks', {
            repositoryId: repoId,
            prompt,
            ...(size ? { size } : {}),
            ...(opts.parentTask ? { parentTaskId: opts.parentTask } : {}),
            ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
          });
          rememberTaskId(result.taskId);
          if (outputOptions().json) emitJson(result);
          else {
            // Under --quiet the id is the sole output, ideal for `id=$(awb task create … --quiet)`.
            printResult(result.taskId);
            printInfo(`Created task (workflow ${result.workflowId}).`);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  // Task DAG orchestration: declare a whole stacked-PR chain/DAG in one shot. Each `--node` is a
  // task (`key='prompt'`); each `--dep child=parent` stacks the child's branch on the parent's and
  // makes the child start only when the parent releases its draft PR.
  task
    .command('task-dag')
    .command('create')
    .description('Declare a stacked-PR task DAG: nodes + dependency edges, driven by the scheduler')
    .option('--repo <repo>', 'Repository path or id (defaults to the last one used)')
    .option(
      '--node <key=prompt>',
      'A task node as key=prompt (repeatable)',
      (val: string, acc: string[] = []) => {
        acc.push(val);
        return acc;
      },
    )
    .option(
      '--dep <child=parent>',
      'A stacking edge: child stacks on parent (repeatable)',
      (val: string, acc: string[] = []) => {
        acc.push(val);
        return acc;
      },
    )
    .action(async (opts: { repo?: string; node?: string[]; dep?: string[] }) => {
      try {
        const repoId = await resolveRepo(opts.repo, undefined);
        const nodeSpecs = opts.node ?? [];
        if (nodeSpecs.length === 0) throw new Error('Provide at least one --node key=prompt.');

        const nodes = nodeSpecs.map((raw) => {
          const eq = raw.indexOf('=');
          if (eq <= 0) throw new Error(`Invalid --node "${raw}": expected key=prompt.`);
          return { key: raw.slice(0, eq), prompt: raw.slice(eq + 1) };
        });
        const depOf = new Map<string, string>();
        for (const raw of opts.dep ?? []) {
          const eq = raw.indexOf('=');
          if (eq <= 0) throw new Error(`Invalid --dep "${raw}": expected child=parent.`);
          depOf.set(raw.slice(0, eq), raw.slice(eq + 1));
        }
        const nodesWithDeps = nodes.map((n) => ({ ...n, ...(depOf.has(n.key) ? { dependsOn: depOf.get(n.key) } : {}) }));

        const result = await daemonClient.post<{ tasks: { key: string; taskId: string; scheduleState: string }[] }>(
          '/api/task-dags',
          { repositoryId: repoId, nodes: nodesWithDeps },
        );
        if (outputOptions().json) emitJson(result);
        else {
          for (const t of result.tasks) printResult(`${t.key}\t${t.taskId}\t${t.scheduleState}`);
          printInfo(`Declared ${result.tasks.length}-node task DAG; roots started, children unblock on parent release.`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('list')
    .description('List tasks')
    .option('--state <state>', 'Only tasks whose condition matches (e.g. running, completed)')
    .option('--repo <repo>', 'Only tasks for this repository (path or id)')
    .option('--limit <n>', 'Maximum number of tasks to show', '20')
    .action(async (opts: { state?: string; repo?: string; limit: string }) => {
      try {
        let tasks = await daemonClient.get<TaskListItem[]>('/api/tasks');
        if (opts.repo) {
          const repoId = await resolveRepoRef(opts.repo);
          tasks = tasks.filter((t) => t.repositoryId === repoId);
        }
        // `--state` filters on live condition; fetch each task's state only when asked to.
        if (opts.state) {
          const withState = await Promise.all(
            tasks.map(async (t) => {
              try {
                const show = await daemonClient.get<TaskShowResponse>(`/api/tasks/${t.repositoryId}/${t.taskId}`);
                return { t, condition: show.state.condition };
              } catch {
                return { t, condition: 'unknown' };
              }
            }),
          );
          tasks = withState.filter((x) => x.condition === opts.state).map((x) => x.t);
        }
        const limit = Number(opts.limit);
        if (!Number.isNaN(limit)) tasks = tasks.slice(0, limit);

        if (outputOptions().json) {
          emitJson(tasks);
          return;
        }
        if (tasks.length === 0) {
          printInfo('No matching tasks. Use `awb task create`.');
          return;
        }
        for (const t of tasks)
          printResult(`${t.taskId}  ${t.repositoryId}  ${t.createdAt}  ${deriveTaskTitle(t.prompt)}`);
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('show [repositoryId] [taskId]')
    .description('Show the current state of a task (ids fall back to the last ones used)')
    .action(async (repositoryId: string | undefined, taskId: string | undefined) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        const result = await daemonClient.get<TaskShowResponse>(`/api/tasks/${repoId}/${tId}`);
        if (outputOptions().json) {
          emitJson(result);
          return;
        }
        // Human-readable: a derived title (from the prompt) above the live state. The prompt is not on
        // the state response, so look it up from the task list; fall back gracefully if unavailable.
        const list = await daemonClient.get<TaskListItem[]>('/api/tasks').catch(() => [] as TaskListItem[]);
        const prompt = list.find((t) => t.taskId === tId)?.prompt;
        if (prompt !== undefined) printResult(deriveTaskTitle(prompt));
        printResult(`${tId}  ${repoId}`);
        printResult(`${result.state.phase} — ${result.state.condition} (delivery: ${result.state.deliveryState})`);
        if (result.pendingHumanGate) printInfo(`awaiting human: ${result.pendingHumanGate.reason}`);
        if (result.openFindings.length > 0) {
          printInfo(`open findings: ${result.openFindings.length}`);
          for (const f of result.openFindings) printInfo(`  - ${f}`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('wait [repositoryId] [taskId]')
    .description('Block quietly until the task finishes or needs a human, then print the final state')
    .option('--timeout <duration>', 'Give up after this long (e.g. 15m)')
    .option('--interval <duration>', 'Poll interval', '3s')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { timeout?: string; interval: string }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        const intervalMs = parseDuration(opts.interval);
        const deadline = opts.timeout ? Date.now() + parseDuration(opts.timeout) : undefined;
        let last: TaskShowResponse | undefined;
        for (;;) {
          last = await daemonClient.get<TaskShowResponse>(`/api/tasks/${repoId}/${tId}`);
          const condition = last.state.condition;
          if (TERMINAL_CONDITIONS.has(condition) || HALTED_CONDITIONS.has(condition)) break;
          if (deadline !== undefined && Date.now() >= deadline) {
            if (outputOptions().json) emitJson({ timedOut: true, state: last.state });
            else printError(`timed out waiting for ${tId} (still ${condition})`);
            process.exitCode = 1;
            return;
          }
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        if (outputOptions().json) emitJson(last);
        else printResult(`${last.state.phase} — ${last.state.condition}`);
        if (last.state.condition === 'failed') process.exitCode = 1;
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('watch [repositoryId] [taskId]')
    .description('Stream live task events (interactive; runs until interrupted)')
    .action(async (repositoryId: string | undefined, taskId: string | undefined) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        printInfo(`watching ${tId} (Ctrl+C to stop)…`);
        await streamEvents(tId, (event) => {
          // Push events are broadcast; show only those tied to this task/run when identifiable.
          const runId = (event as { runId?: string; taskId?: string }).runId ?? (event as { taskId?: string }).taskId;
          if (runId && runId !== tId && runId !== `${repoId}/${tId}`) return;
          process.stdout.write(`${JSON.stringify(event)}\n`);
        });
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('result [repositoryId] [taskId]')
    .description('Print the task result (final state + open findings)')
    .action(async (repositoryId: string | undefined, taskId: string | undefined) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        const show = await daemonClient.get<TaskShowResponse>(`/api/tasks/${repoId}/${tId}`);
        if (outputOptions().json) {
          emitJson({ state: show.state, openFindings: show.openFindings });
          return;
        }
        printResult(`${show.state.phase} — ${show.state.condition} (delivery: ${show.state.deliveryState})`);
        if (show.openFindings.length > 0) {
          printInfo(`open findings: ${show.openFindings.length}`);
          for (const f of show.openFindings) printInfo(`  - ${f}`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('timeline [repositoryId] [taskId]')
    .description('Print the post-hoc timeline: phase durations, outcomes, QA, evidence and cost')
    .action(async (repositoryId: string | undefined, taskId: string | undefined) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        const timeline = await daemonClient.get<TimelineResponse>(
          `/api/tasks/${repoId}/${tId}/timeline`,
        );
        if (outputOptions().json) {
          emitJson(timeline);
          return;
        }
        for (const line of renderTimeline(timeline)) printResult(line);
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('logs [repositoryId] [taskId]')
    .description('Print the recorded semantic events for a task')
    .option('--tail <count>', 'Number of trailing events to show', '50')
    .action(async (_repositoryId: string | undefined, taskId: string | undefined, opts: { tail: string }) => {
      try {
        const tId = resolveTaskId(taskId);
        const res = await daemonClient
          .get<{ events: unknown[] }>(eventsQueryFor(tId))
          .catch(() => ({ events: [] as unknown[] }));
        let events = res.events;
        const tail = Number(opts.tail);
        if (!Number.isNaN(tail)) events = events.slice(-tail);
        if (outputOptions().json) {
          emitJson(events);
          return;
        }
        if (events.length === 0) {
          printInfo('No recorded events for this task yet.');
          return;
        }
        for (const e of events) process.stdout.write(`${JSON.stringify(e)}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('cancel [repositoryId] [taskId]')
    .description('Cancel a running task (ids fall back to the last ones used)')
    .action(async (repositoryId: string | undefined, taskId: string | undefined) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/cancel`);
        if (outputOptions().json) emitJson({ cancelled: tId });
        else printInfo('Cancel signal sent.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('retry [repositoryId] [taskId]')
    .description('Re-run a task from its original prompt as a fresh task')
    .action(async (repositoryId: string | undefined, taskId: string | undefined) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        const all = await daemonClient.get<TaskListItem[]>('/api/tasks');
        const original = all.find((t) => t.taskId === tId);
        if (!original) {
          printError(`No task ${tId} to retry.`);
          process.exitCode = 1;
          return;
        }
        const result = await daemonClient.post<CreatedTask>('/api/tasks', {
          repositoryId: repoId,
          prompt: original.prompt,
          // Establish cross-task retry lineage: the daemon resolves the shared rootTaskId from this.
          retryOfTaskId: tId,
        });
        rememberTaskId(result.taskId);
        if (outputOptions().json) emitJson(result);
        else {
          printResult(result.taskId);
          printInfo(`Retried as new task (workflow ${result.workflowId}).`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('remove [repositoryId] [taskId]')
    .alias('rm')
    .description('Delete a task and all of its rows (terminates the workflow first)')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { yes?: boolean }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        if (opts.yes !== true && !outputOptions().input) {
          printError(`Refusing to remove ${tId} without --yes (no interactive input available).`);
          process.exitCode = 1;
          return;
        }
        await daemonClient.del(`/api/tasks/${repoId}/${tId}`);
        if (outputOptions().json) emitJson({ removed: tId });
        else printInfo(`Removed task ${tId} and its rows.`);
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('prune')
    .description('Delete terminal task rows (default: abandoned) whose workflow no longer exists')
    .option('--older-than <duration>', 'Only prune tasks untouched for at least this long (e.g. 7d)')
    .option(
      '--condition <condition...>',
      'Conditions to prune instead of the default `abandoned` (e.g. abandoned failed)',
    )
    .option('--dry-run', 'List what would be pruned and delete nothing')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (opts: { olderThan?: string; condition?: string[]; dryRun?: boolean; yes?: boolean }) => {
      try {
        const dryRun = opts.dryRun === true;
        if (!dryRun && opts.yes !== true && !outputOptions().input) {
          printError('Refusing to prune without --yes (no interactive input available). Try --dry-run first.');
          process.exitCode = 1;
          return;
        }
        const body = {
          dryRun,
          ...(opts.olderThan ? { olderThanMs: parseDuration(opts.olderThan) } : {}),
          ...(opts.condition ? { conditions: opts.condition } : {}),
        };
        const res = await daemonClient.post<PruneResponse>('/api/tasks/prune', body);
        if (outputOptions().json) {
          emitJson(res);
          return;
        }
        if (res.tasks.length === 0) {
          printInfo('Nothing to prune.');
          return;
        }
        for (const t of res.tasks) {
          printResult(`${t.taskId}  ${t.condition}  last moved ${t.updatedAt}`);
        }
        printInfo(dryRun ? `${res.tasks.length} task(s) would be pruned.` : `Pruned ${res.pruned} task(s).`);
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('open [repositoryId] [taskId]')
    .description('Open the task in the web UI')
    .action((repositoryId: string | undefined, taskId: string | undefined) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        const url = `http://localhost:${uiPort()}/tasks/${repoId}/${tId}`;
        const command =
          process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        const child = spawn(command, args, { detached: true, stdio: 'ignore' });
        child.unref();
        if (outputOptions().json) emitJson({ opened: url });
        else printInfo(`Opening ${url}`);
      } catch (err) {
        handleError(err);
      }
    });

  registerTaskSignalCommands(task);
}

/** Contract/plan approval + PR lifecycle signals, kept together for readability. */
function registerTaskSignalCommands(task: Command): void {
  task
    .command('approve-contract [repositoryId] [taskId]')
    .description('Approve the current task contract (ids fall back to the last ones used)')
    .requiredOption('--contract-version <version>', 'Contract version to approve', '1')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { contractVersion: string }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/approve-contract`, {
          contractVersion: Number(opts.contractVersion),
        });
        printInfo('Contract approved.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('approve-plan [repositoryId] [taskId]')
    .description('Approve the current implementation plan (ids fall back to the last ones used)')
    .requiredOption('--plan-version <version>', 'Plan version to approve', '1')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { planVersion: string }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/approve-plan`, { planVersion: Number(opts.planVersion) });
        printInfo('Plan approved.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('reject-plan [repositoryId] [taskId]')
    .description('Reject the current implementation plan (ids fall back to the last ones used)')
    .requiredOption('--reason <reason>', 'Why the plan is rejected')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { reason: string }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/reject-plan`, { reason: opts.reason });
        printInfo('Plan rejected.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('pr-merged [repositoryId] [taskId]')
    .description('Signal that the delivered PR was merged, completing the task')
    .requiredOption('--sha <sha>', 'Merge commit SHA')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { sha: string }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/pr-merged`, { mergeCommitSha: opts.sha });
        printInfo('PR-merged signal sent.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('pr-closed [repositoryId] [taskId]')
    .description('Signal that the delivered PR was closed without merging')
    .action(async (repositoryId: string | undefined, taskId: string | undefined) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/pr-closed`);
        printInfo('PR-closed signal sent.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('pr-feedback [repositoryId] [taskId]')
    .description('Signal that PR review feedback was received')
    .requiredOption('--feedback-id <feedbackId>', 'Identifier for the received feedback')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { feedbackId: string }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/pr-feedback`, { feedbackId: opts.feedbackId });
        printInfo('PR-feedback signal sent.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('deliver-worktree [repositoryId] [taskId]')
    .description(
      "Recover-and-land: open a DRAFT PR from the task's committed worktree branch when the run " +
        'never reached release (verify hung/was killed). Verification is NOT run; review before merge.',
    )
    .action(async (repositoryId: string | undefined, taskId: string | undefined) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        const res = await daemonClient.post<{ ok: boolean; prNumber: number; prUrl?: string; title: string }>(
          `/api/tasks/${repoId}/${tId}/deliver-worktree`,
        );
        if (outputOptions().json) emitJson(res);
        else printInfo(`Draft PR #${res.prNumber} opened${res.prUrl ? ` — ${res.prUrl}` : ''} (verification NOT run).`);
      } catch (err) {
        handleError(err);
      }
    });
}

/** Opens the daemon's WebSocket event stream and invokes onEvent for each parsed message. */
async function streamEvents(_taskId: string, onEvent: (event: unknown) => void): Promise<void> {
  const wsUrl = `${daemonBaseUrl().replace(/^http/, 'ws')}/api/events/stream`;
  await new Promise<void>((resolve, reject) => {
    // Node's global WebSocket (stable since Node 22) — no extra dependency needed.
    const socket = new WebSocket(wsUrl);
    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        onEvent(JSON.parse(String(event.data)));
      } catch {
        // ignore non-JSON frames
      }
    });
    socket.addEventListener('error', () => reject(new Error('event stream error')));
    socket.addEventListener('close', () => resolve());
  });
}
