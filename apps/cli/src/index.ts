#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerRepoCommands } from './commands/repo.js';
import { registerDaemonCommands } from './commands/daemon.js';
import { registerTaskCommands } from './commands/task.js';
import { registerUpDown } from './commands/up.js';
import { registerStub } from './commands/not-implemented.js';

const program = new Command();
program.name('awb').description('Agentic Workbench CLI').version('0.1.0');

registerInit(program);
registerUpDown(program);
registerDaemonCommands(program);
registerRepoCommands(program);
registerTaskCommands(program);

// "resume" has no daemon-side meaning beyond the Workflow's own `resume` Signal, which isn't
// exposed as a route yet — kept an explicit stub rather than a fake command.
registerStub(program, 'task resume', 'Resume a paused task', 'Milestone 10 follow-up');

registerStub(program, 'open', 'Open the local UI', 'Milestone 10 (web UI)');

// `pnpm --filter @awb/cli cli -- <args>` forwards a leading `--` into our argv. Commander treats
// `--` as the options terminator, so it would swallow subcommand options like `--prompt`
// (TASK-10). Strip a single `--` that appears before the first subcommand token so the documented
// `pnpm … cli -- task create --prompt …` invocation parses identically to `awb task create …`.
const argv = [...process.argv];
const firstNonNodeArg = 2;
if (argv[firstNonNodeArg] === '--') {
  argv.splice(firstNonNodeArg, 1);
}

program.parseAsync(argv).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
