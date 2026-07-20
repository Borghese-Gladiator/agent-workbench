#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerRepoCommands } from './commands/repo.js';
import { registerStub } from './commands/not-implemented.js';

const program = new Command();
program.name('awb').description('Agentic Workbench CLI').version('0.1.0');

registerInit(program);

registerStub(program, 'daemon start', 'Start the local daemon', 'Milestone 10');
registerStub(program, 'daemon stop', 'Stop the local daemon', 'Milestone 10');

registerRepoCommands(program);

// Every `task ...` command needs a running daemon (Milestone 10) to act as the Temporal client —
// the Workflow/completion-policy engine (Milestone 3) and planning/implementation loop
// (Milestone 6) exist, but nothing yet starts a worker + exposes it over the CLI/API.
registerStub(program, 'task create', 'Create a task', 'Milestone 10');
registerStub(program, 'task list', 'List tasks', 'Milestone 10');
registerStub(program, 'task show', 'Show a task', 'Milestone 10');
registerStub(program, 'task approve-contract', 'Approve a task contract', 'Milestone 10');
registerStub(program, 'task cancel', 'Cancel a task', 'Milestone 10');
registerStub(program, 'task resume', 'Resume a task', 'Milestone 10');

registerStub(program, 'open', 'Open the local UI', 'Milestone 10');

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
