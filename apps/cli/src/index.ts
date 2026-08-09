#!/usr/bin/env node

/**
 * A stale/unbuilt `@awb/*` dist is the insidious CLI failure mode (TASK-69): the daemon/worker run
 * from source via tsx, but the CLI imports its workspace packages from their compiled `dist/`. When a
 * package's source gains an export its `dist/` doesn't have yet, the CLI crashes at MODULE LOAD with
 * an `ERR_MODULE_NOT_FOUND` / `SyntaxError: … does not provide an export named …` — before any command
 * runs. During a live run that reads as a blank `task show` (no output), which a driver easily
 * misreads as a stalled task. So the command modules are loaded via a guarded dynamic import: a
 * module-resolution failure is translated into an actionable "run pnpm build" message instead of a
 * raw stack or a blank line.
 */
function isStaleDistError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code ?? '';
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return true;
  const msg = err.message;
  return (
    /does not provide an export named/.test(msg) ||
    /Cannot find module '@awb\//.test(msg) ||
    (/@awb\//.test(msg) && /export|module/i.test(msg))
  );
}

async function main(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerInit } = await import('./commands/init.js');
  const { registerRepoCommands } = await import('./commands/repo.js');
  const { registerDaemonCommands } = await import('./commands/daemon.js');
  const { registerTaskCommands } = await import('./commands/task.js');
  const { registerLifecycleCommands } = await import('./commands/lifecycle.js');
  const { registerDoctorCommand } = await import('./commands/doctor.js');
  const { registerUiCommands } = await import('./commands/ui.js');
  const { registerConfigCommands } = await import('./commands/config.js');
  const { registerCompletionCommand } = await import('./commands/completion.js');
  const { registerResetCommands } = await import('./commands/reset.js');
  const { registerMemoryCommands } = await import('./commands/memory.js');
  const { configureOutput } = await import('./output.js');

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
  registerMemoryCommands(program);

  await program.parseAsync(argv);
}

// `pnpm --filter @awb/cli cli -- <args>` forwards a leading `--` into our argv. Commander treats
// `--` as the options terminator, so it would swallow subcommand options like `--prompt`.
// Strip a single `--` that appears before the first subcommand token so the documented
// `pnpm … cli -- task create --prompt …` invocation parses identically to `awb task create …`.
const argv = [...process.argv];
const firstNonNodeArg = 2;
if (argv[firstNonNodeArg] === '--') {
  argv.splice(firstNonNodeArg, 1);
}

main(argv).catch((err: unknown) => {
  if (isStaleDistError(err)) {
    console.error(
      'awb: a workbench package is stale or unbuilt — run `pnpm build` and retry.\n' +
        `  (${err instanceof Error ? err.message : String(err)})`,
    );
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
});
