#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerStub } from './commands/not-implemented.js';

const program = new Command();
program.name('awb').description('Agentic Workbench CLI').version('0.1.0');

registerInit(program);

registerStub(program, 'daemon start', 'Start the local daemon', 'Milestone 10');
registerStub(program, 'daemon stop', 'Stop the local daemon', 'Milestone 10');

registerStub(program, 'repo add', 'Register a repository', 'Milestone 2');
registerStub(program, 'repo list', 'List registered repositories', 'Milestone 2');
registerStub(program, 'repo inspect', 'Inspect a repository', 'Milestone 2');
registerStub(program, 'repo refresh', 'Refresh a repository snapshot', 'Milestone 2');
registerStub(program, 'repo approve', 'Approve a discovered repository profile', 'Milestone 2');

registerStub(program, 'task create', 'Create a task', 'Milestone 3/6');
registerStub(program, 'task list', 'List tasks', 'Milestone 3');
registerStub(program, 'task show', 'Show a task', 'Milestone 3');
registerStub(program, 'task approve-contract', 'Approve a task contract', 'Milestone 6');
registerStub(program, 'task cancel', 'Cancel a task', 'Milestone 3');
registerStub(program, 'task resume', 'Resume a task', 'Milestone 3');

registerStub(program, 'open', 'Open the local UI', 'Milestone 10');

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
