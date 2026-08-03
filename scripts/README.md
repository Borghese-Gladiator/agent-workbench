# scripts/

Durable developer tooling — scripts that are meant to be checked in and reused,
as opposed to one-off commands or throwaway snippets.

## `audit-docs.sh`

Proves the agent-facing docs don't lie about the repo: every structural path
claim in `AGENTS.md` / `README.md` resolves against the real filesystem, the
root entrypoint files exist, and the "every package has a README" invariant
holds. Exit 0 when clean, nonzero on drift.

- Run directly: `scripts/audit-docs.sh`, or `pnpm run audit:docs`.
- It runs automatically as a **pre-commit hook** (`.githooks/pre-commit`). The
  audit is just path resolution (milliseconds), so it always runs — a
  filename-based "only when docs change" trigger is unreliable (a README
  removed via rename doesn't look like a README change but still breaks a
  claim). Bypass in an emergency with `git commit --no-verify`.
- The hook is installed by the `prepare` npm script (`git config
  core.hooksPath .githooks`), which runs on `pnpm install`. `core.hooksPath`
  is local git config and doesn't travel with the branch, so the `prepare`
  step is what wires it up for each clone/checkout.

## other operations

The day-to-day workbench operations are exposed as first-class CLI commands
rather than shell scripts:

- Boot / health / teardown: `awb up`, `awb status --json`, `awb down`
  (see `AGENTS.md` → "Agent Workbench commands").
- Diagnostics: `awb doctor --json`, `awb logs daemon --tail 50`.
- Feature verification cheat-sheets live in `docs/` (e.g.
  `docs/verify-task-36-37.md`) as copy-paste query sets, not scripts.

Add a script here only when it is durable, repo-scoped tooling that doesn't
belong behind an `awb` subcommand. Keep it executable (`chmod +x`) with a
shebang, and reference it from `AGENTS.md` or the relevant doc so it's
discoverable.
