import type { Command } from 'commander';
import { printResult } from '../output.js';

/**
 * Emits a shell completion script that offers the top-level command names. Kept intentionally
 * simple — it completes the first argument (the command), which covers the common case; deeper
 * subcommand completion can be layered on later.
 */
export function registerCompletionCommand(program: Command): void {
  program
    .command('completion [shell]')
    .description('Generate shell completions (bash or zsh)')
    .action((shell: string | undefined) => {
      const commands = program.commands
        .map((c) => c.name())
        .filter((n) => n !== 'completion')
        .join(' ');
      const target = shell ?? 'bash';
      if (target === 'zsh') {
        printResult(
          [
            '#compdef awb',
            '_awb() {',
            `  local -a cmds; cmds=(${commands})`,
            '  _arguments "1: :($cmds)" "*::arg:->args"',
            '}',
            '_awb "$@"',
          ].join('\n'),
        );
        return;
      }
      printResult(
        [
          '_awb_completions() {',
          '  local cur="${COMP_WORDS[COMP_CWORD]}"',
          `  local cmds="${commands}"`,
          '  if [ "$COMP_CWORD" -eq 1 ]; then',
          '    COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )',
          '  fi',
          '}',
          'complete -F _awb_completions awb',
        ].join('\n'),
      );
    });
}
