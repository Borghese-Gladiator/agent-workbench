import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { daemonClient, daemonBaseUrl, DaemonRequestError } from '../daemon-client.js';
import { rememberTaskId, resolveRepositoryId, resolveTaskId } from '../remembered.js';
import { resolveRepoRef } from './repo.js';
import { emitJson, outputOptions, printError, printInfo, printResult } from '../output.js';
import { parseDuration } from '../duration.js';
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

interface TaskShowResponse {
  state: { phase: string; condition: string; deliveryState: string };
  openFindings: string[];
  pendingHumanGate?: { reason: string } | null;
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
        for (const t of tasks) printResult(`${t.taskId}  ${t.repositoryId}  ${t.createdAt}  ${t.prompt}`);
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
        emitJson(result);
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
    .command('logs [repositoryId] [taskId]')
    .description('Print the recorded semantic events for a task')
    .option('--tail <count>', 'Number of trailing events to show', '50')
    .action(async (_repositoryId: string | undefined, taskId: string | undefined, opts: { tail: string }) => {
      try {
        const tId = resolveTaskId(taskId);
        const res = await daemonClient.get<{ events: unknown[] }>(
          `/api/events?runId=${encodeURIComponent(tId)}&afterSequence=0`,
        ).catch(() => ({ events: [] as unknown[] }));
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
