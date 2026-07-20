# Brief — Hello command

## Goal

Add a `hello` subcommand to the throwaway repo's CLI.

## User-facing behavior

Running `bin/cli hello` prints `hello, world` on stdout and exits 0.

## Acceptance criteria

- AC-1: `bin/cli hello` exits 0.
- AC-2: stdout contains the string `hello, world`.

## Non-goals

- Argument parsing for the hello subcommand.
- Localization.

## Good examples

- `bin/cli hello` -> `hello, world`

## Bad examples

- Anything that requires reading a config file.

## Constraints

- No new dependencies.

## Assumptions

- The repo has a single CLI entry point at `bin/cli`.

## Files likely to change

- `bin/cli`

## Suggested QA scenarios

- Run the new command directly; confirm exit code and output.
