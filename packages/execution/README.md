# @awb/execution

## Purpose

Scoped command execution, process supervision, and environment-digest
computation (product spec §17, §22).

## Responsibilities

- `command-runner.ts` — spawns a command with an explicitly allowlisted
  environment (never inherits `process.env` wholesale by default), captures
  stdout/stderr, enforces a timeout, and can kill the **entire process
  tree** (POSIX process-group kill via `detached: true` + `process.kill(-pid)`,
  not just the top PID) — verified with a real, non-mocked test.
- `process-registry.ts` — in-memory registry of currently-supervised
  processes per task, so cancellation/cleanup can kill everything for a
  task in one call.
- `environment-digest.ts` — pure `computeEnvironmentDigest(input)`: a
  deterministic hash over platform, Node version, tool versions, and
  resolved env values, used by Verify/Exercise completion criteria to tie
  evidence to an exact environment.

## Does NOT

- Store command output as artifacts — that's `@awb/evidence`; this package
  only returns captured output, the caller decides what to persist.
- Persist `ValidatedCommand`/`command_executions` rows — that's
  `@awb/repository`/the daemon.

## Dependencies

`@awb/domain`.
