import type { Command } from 'commander';

/**
 * Registers a (possibly namespaced, e.g. "repo add") command that reports it is not yet
 * implemented, keyed to the milestone that will implement it. Namespace segments are created
 * as nested subcommands on first use and reused on subsequent calls.
 */
export function registerStub(
  program: Command,
  name: string,
  description: string,
  milestone: string,
): void {
  const segments = name.split(' ');
  const leafName = segments[segments.length - 1] as string;
  const namespaceSegments = segments.slice(0, -1);

  let parent = program;
  for (const segment of namespaceSegments) {
    const existing = parent.commands.find((c) => c.name() === segment);
    if (existing) {
      parent = existing;
    } else {
      const namespaceCommand = parent.command(segment);
      parent = namespaceCommand;
    }
  }

  parent
    .command(leafName)
    .description(`${description} (not yet implemented — ${milestone})`)
    .allowUnknownOption(true)
    .action(() => {
      console.error(`'${name}' is not yet implemented (${milestone}).`);
      process.exitCode = 1;
    });
}
