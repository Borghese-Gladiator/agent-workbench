# @awb/cli

## Purpose

The `awb` command-line entry point.

## Responsibilities

- `awb init` — bootstrap the local data directory.
- `awb repo add/list/inspect/refresh/approve` — register and manage
  repositories, fully wired to `@awb/repository` + `@awb/database`.
- Every other command in the product spec's CLI surface (`daemon start/stop`,
  `task ...`, `open`) is registered as an explicit not-yet-implemented stub
  (`commands/not-implemented.ts`) keyed to the milestone that will land it —
  running one fails loudly with a clear message rather than silently no-op'ing.

## Does NOT

- Talk to SQLite directly from command handlers beyond opening the shared
  connection (`db.ts`) — business logic lives in the packages the CLI calls
  into, not in command handler bodies.

## Dependencies

`@awb/config`, `@awb/database`, `@awb/domain`, `@awb/repository`, `commander`.
