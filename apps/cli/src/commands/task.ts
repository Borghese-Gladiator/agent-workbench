import type { Command } from 'commander';
import { daemonClient, DaemonRequestError } from '../daemon-client.js';

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
    .command('create <repositoryId>')
    .description('Create a task against a registered repository')
    .requiredOption('--prompt <prompt>', 'Natural-language task prompt')
    .action(async (repositoryId: string, opts: { prompt: string }) => {
      try {
        const result = await daemonClient.post<{ taskId: string; workflowId: string }>('/api/tasks', {
          repositoryId,
          prompt: opts.prompt,
        });
        console.log(`Created task ${result.taskId} (workflow ${result.workflowId}).`);
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('show <repositoryId> <taskId>')
    .description('Show the current state of a task')
    .action(async (repositoryId: string, taskId: string) => {
      try {
        const result = await daemonClient.get(`/api/tasks/${repositoryId}/${taskId}`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('approve-contract <repositoryId> <taskId>')
    .description('Approve the current task contract')
    .requiredOption('--version <version>', 'Contract version to approve', '1')
    .action(async (repositoryId: string, taskId: string, opts: { version: string }) => {
      try {
        await daemonClient.post(`/api/tasks/${repositoryId}/${taskId}/approve-contract`, {
          contractVersion: Number(opts.version),
        });
        console.log('Contract approved.');
      } catch (err) {
        handleError(err);
      }
    });

  task
    .command('cancel <repositoryId> <taskId>')
    .description('Cancel a running task')
    .action(async (repositoryId: string, taskId: string) => {
      try {
        await daemonClient.post(`/api/tasks/${repositoryId}/${taskId}/cancel`);
        console.log('Cancel signal sent.');
      } catch (err) {
        handleError(err);
      }
    });
}
