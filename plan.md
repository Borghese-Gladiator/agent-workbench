# Plan: help text for all awb commands

## Brief
`awb run --help` starts a real run. No command handles `--help`.
Add help text for each command. Show it before any other work starts.

## Changes
- Add `packages/cli/src/help.ts`. It holds a usage string for each command and a `helpFor` function.
- In `packages/cli/src/main.ts`, check for `--help` or `-h` before the `switch`. Print the help and exit with code 0.
- `awb help [command]`, `awb --help`, and `awb -h` print the command list.
- A bare `awb` still starts the launch flow.

## Tests
### Unit
- `packages/cli/test/help.test.ts`. Parametrized. Each name in the command list has a help entry.
- `helpFor` returns the usage for a known command and `undefined` for an unknown command.

### Manual
Backend script. Run each line and check that the output is help text and the exit code is 0.
```
for c in ui doctor daemon stack prove ship run retry stop show tasks cost logs task sessions wt; do
  bin/awb $c --help || echo "FAIL $c"
done
```
