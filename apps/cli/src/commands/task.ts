import type { Command } from 'commander';
import { daemonClient, DaemonRequestError } from '../daemon-client.js';
import { rememberTaskId, resolveRepositoryId, resolveTaskId } from '../remembered.js';

function handleError(err: unknown): void {
  if (err instanceof DaemonRequestError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
}

export function registerTaskCommands(program: Command): void {
  const task = program.command('task').description('Create and manage tasks');

  task
    .command('create [repositoryId]')
    .description('Create a task against a registered repository (repositoryId falls back to the last one used)')
    .requiredOption('--prompt <prompt>', 'Natural-language task prompt')
    .option('--json', 'Print the created task as JSON')
    .action(async (repositoryId: string | undefined, opts: { prompt: string; json?: boolean }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const result = await daemonClient.post<{ taskId: string; workflowId: string }>('/api/tasks', {
          repositoryId: repoId,
          prompt: opts.prompt,
        });
        rememberTaskId(result.taskId);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Created task ${result.taskId} (workflow ${result.workflowId}).`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('list')
    .description('List tasks created in this daemon session')
    .option('--json', 'Print the task list as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const tasks = await daemonClient.get<
          { taskId: string; repositoryId: string; workflowId: string; prompt: string; createdAt: string }[]
        >('/api/tasks');
        if (opts.json) {
          console.log(JSON.stringify(tasks, null, 2));
          return;
        }
        if (tasks.length === 0) {
          console.log('No tasks created this session. Use `awb task create`.');
          return;
        }
        for (const t of tasks) {
          console.log(`${t.taskId}  ${t.repositoryId}  ${t.createdAt}  ${t.prompt}`);
        }
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
        const result = await daemonClient.get(`/api/tasks/${repoId}/${tId}`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('approve-contract [repositoryId] [taskId]')
    .description('Approve the current task contract (ids fall back to the last ones used)')
    .requiredOption('--version <version>', 'Contract version to approve', '1')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { version: string }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/approve-contract`, {
          contractVersion: Number(opts.version),
        });
        console.log('Contract approved.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('approve-plan [repositoryId] [taskId]')
    .description('Approve the current implementation plan (ids fall back to the last ones used)')
    .requiredOption('--version <version>', 'Plan version to approve', '1')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { version: string }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/approve-plan`, { planVersion: Number(opts.version) });
        console.log('Plan approved.');
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
        console.log('Plan rejected.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('pr-merged [repositoryId] [taskId]')
    .description('Signal that the delivered PR was merged, completing the task (ids fall back to the last ones used)')
    .requiredOption('--sha <sha>', 'Merge commit SHA')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { sha: string }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/pr-merged`, { mergeCommitSha: opts.sha });
        console.log('PR-merged signal sent.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('pr-closed [repositoryId] [taskId]')
    .description('Signal that the delivered PR was closed without merging (ids fall back to the last ones used)')
    .action(async (repositoryId: string | undefined, taskId: string | undefined) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/pr-closed`);
        console.log('PR-closed signal sent.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('pr-feedback [repositoryId] [taskId]')
    .description('Signal that PR review feedback was received (ids fall back to the last ones used)')
    .requiredOption('--feedback-id <feedbackId>', 'Identifier for the received feedback')
    .action(async (repositoryId: string | undefined, taskId: string | undefined, opts: { feedbackId: string }) => {
      try {
        const repoId = resolveRepositoryId(repositoryId);
        const tId = resolveTaskId(taskId);
        await daemonClient.post(`/api/tasks/${repoId}/${tId}/pr-feedback`, { feedbackId: opts.feedbackId });
        console.log('PR-feedback signal sent.');
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
        console.log('Cancel signal sent.');
      } catch (err) {
        handleError(err);
      }
    });
}
