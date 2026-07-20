# @awb/config

## Purpose

Resolves and bootstraps the local `~/.agentic-workbench/` data directory
layout, and loads/saves `config.yaml`.

## Responsibilities

- `resolveDataDir()` / `resolveLayout()` — compute every path under the data
  root, honoring the `AWB_DATA_DIR` override.
- `ensureDataDir()` / `initDataDir()` — create the directory tree and a
  default `config.yaml` on first run.
- Load/save/validate `config.yaml` via a Zod schema.

## Does NOT

- Own the SQLite connection itself (see `@awb/database`).
- Know anything about repositories, tasks, or the lifecycle — this package
  is pure filesystem-layout plumbing.

## Dependencies

`@awb/domain`, `yaml`, `zod`.
