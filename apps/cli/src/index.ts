#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerRepoCommands } from './commands/repo.js';
import { registerDaemonCommands } from './commands/daemon.js';
import { registerTaskCommands } from './commands/task.js';
import { registerStub } from './commands/not-implemented.js';

const program = new Command();
program.name('awb').description('Agentic Workbench CLI').version('0.1.0');

registerInit(program);
registerDaemonCommands(program);
registerRepoCommands(program);
registerTaskCommands(program);

// The daemon has no list-all-tasks endpoint yet (it's a thin Temporal client and Temporal has no
// built-in "list every workflow" query without a visibility store query API this MVP doesn't
// wire yet), and "resume" has no daemon-side meaning beyond the Workflow's own `resume` Signal,
// which isn't exposed as a route yet either — both stay explicit stubs rather than fake commands.
registerStub(program, 'task list', 'List tasks', 'Milestone 10 follow-up');
registerStub(program, 'task resume', 'Resume a paused task', 'Milestone 10 follow-up');

registerStub(program, 'open', 'Open the local UI', 'Milestone 10 (web UI)');

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
