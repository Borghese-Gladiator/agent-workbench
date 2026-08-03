# scripts/

Durable developer tooling — scripts that are meant to be checked in and reused,
as opposed to one-off commands or throwaway snippets.

Nothing here yet. The day-to-day workbench operations are exposed as first-class
CLI commands rather than shell scripts:

- Boot / health / teardown: `awb up`, `awb status --json`, `awb down`
  (see `AGENTS.md` → "Agent Workbench commands").
- Diagnostics: `awb doctor --json`, `awb logs daemon --tail 50`.
- Feature verification cheat-sheets live in `docs/` (e.g.
  `docs/verify-task-36-37.md`) as copy-paste query sets, not scripts.

Add a script here only when it is durable, repo-scoped tooling that doesn't
belong behind an `awb` subcommand. Keep it executable (`chmod +x`) with a
shebang, and reference it from `AGENTS.md` or the relevant doc so it's
discoverable.
