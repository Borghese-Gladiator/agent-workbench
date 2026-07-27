#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerRepoCommands } from './commands/repo.js';
import { registerDaemonCommands } from './commands/daemon.js';
import { registerTaskCommands } from './commands/task.js';
import { registerLifecycleCommands } from './commands/lifecycle.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerUiCommands } from './commands/ui.js';
import { registerConfigCommands } from './commands/config.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerResetCommands } from './commands/reset.js';
import { configureOutput } from './output.js';

const program = new Command();
program
  .name('awb')
  .description('Agent Workbench CLI')
  .version('0.1.0')
  // Global output contract. `--no-color` / `--no-input` are commander negations of on-by-default
  // booleans, so they surface as `color`/`input` = false.
  .option('-q, --quiet', 'Suppress successful informational output')
  .option('--json', 'Emit stable machine-readable output')
  .option('-v, --verbose', 'Include diagnostic information')
  .option('--no-color', 'Disable ANSI formatting')
  .option('--no-input', 'Never prompt for input');

// Resolve the effective output options once, before any subcommand action runs.
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts<{
    quiet?: boolean;
    json?: boolean;
    verbose?: boolean;
    color?: boolean;
    input?: boolean;
  }>();
  configureOutput(opts);
});

registerInit(program);
registerLifecycleCommands(program);
registerDoctorCommand(program);
registerUiCommands(program);
registerDaemonCommands(program);
registerRepoCommands(program);
registerTaskCommands(program);
registerConfigCommands(program);
registerCompletionCommand(program);
registerResetCommands(program);

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
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
