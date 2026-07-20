# Agent Workbench — agent guide

Local-first control plane + dashboard for driving agentic dev tasks through a
human-gated lifecycle. This file is the fast path for an agent working IN this
repo. The `README.md` is the long-form human tour; `docs/` holds design notes and
historical investigations. When this file and the README disagree, the **code**
(`packages/core/src/lifecycle.ts`) wins — trust it over prose.

## Commands

Run from the repo root. pnpm 10, Node ≥ 20.

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Typecheck | `pnpm typecheck` |
| Build packages | `pnpm build` |
| Unit/integration tests | `pnpm test` |
| One package's tests | `pnpm --filter @workbench/<pkg> test` |
| Lint / format | `pnpm lint` · `pnpm format` |
| E2E walkthrough (Playwright) | `pnpm test:e2e` |
| End-to-end proof (PASS/FAIL bundle) | `pnpm proof` |
| Daemon (API :4417) | `pnpm daemon` |
| Dashboard (:5317) | `pnpm web` |
| Seed example project+task | `pnpm seed` |
| Headless driver CLI | `pnpm wb <cmd>` |

`better-sqlite3` is native; `pnpm rebuild better-sqlite3` if its binding fails.

## Invariants — do not break these

- **The browser never touches the filesystem, git, or a shell.** `apps/web`
  speaks only to the daemon over `/api` (JSON). All side effects live in the
  daemon.
- **Domain logic lives in `packages/core`** — pure, no IO, unit-tested. Do not
  put lifecycle rules in React or in route handlers.
- **The daemon is the single owner of SQLite, disk, and git.** Adapters
  (`agents`, `validation`, `delivery`) are **pure compute**: they return content
  and never write SQLite/disk/git directly.
- **No runtime string branches.** Runtime behavior is data — one `RuntimeProfile`
  per runtime (`packages/agents/src/runtime-profile.ts`). Adding a harness =
  adding a profile, not an `if (runtime === …)`.
- **One task → one worktree → one branch.** The project's main checkout is never
  mutated. A self-targeting project refuses the skip-worktree path.
- **The three action surfaces derive from `LIFECYCLE_ACTIONS`** (core) so daemon
  routes, the `wb` CLI, and the MCP `do_action` enum cannot drift. Add an action
  there, not in three places.

## Lifecycle (source: `packages/core/src/lifecycle.ts`)

14 ordered stages. `[bracketed]` = human gate (task parks). Every non-gate,
non-terminal stage after the brief is auto-advanced by the driver.

```
intake → task_brief → [human_brief_approval] → discovery → [human_plan_approval] →
implementation → static_checks → feature_e2e → agent_self_review → [human_review] →
delivery_prep → [human_delivery_approval] → publish → closeout
```

- **Worktree creation is NOT a stage** — it's a side-effect of `approve-brief`
  (human_brief_approval → discovery).
- `static_checks` + `feature_e2e` roll up to one **Verification** node in the UI
  (`STAGE_GROUP_LABELS`); a failing check parks the task at that stage.
- Actions (`LIFECYCLE_ACTIONS`): `generate-brief`, `resume`, `approve-brief`,
  `reject-brief`, `approve-plan`, `reject-plan`, `review/complete`,
  `review/bounce` (`--target implementation|discovery`), `approve-delivery`,
  `reject-delivery`, `abandon`. Reject/bounce require a comment — it's the only
  feedback the regenerated artifact gets.
- `status` is orthogonal to `stage`: `active → ready_to_publish → done`, or
  `abandoned` from anywhere.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Domain types + pure lifecycle rules. No IO. |
| `packages/store` | SQLite persistence; artifact bodies on disk (`data/artifacts/`). |
| `packages/worktree` | `GitWorktreeProvider` (real `git worktree`) + stub. |
| `packages/agents` | `AgentRuntimeAdapter` + mock/claude/pi/codex; `RuntimeProfile`; per-stage tool policy. |
| `packages/validation` | `CommandValidationRunner` — runs the project's real test/lint/typecheck. |
| `packages/delivery` | `GitDeliveryAdapter` — commit + (unless dry-run) push + `gh` PR. |
| `packages/client` | `createClient(baseUrl)` — the one typed API client; backs the browser AND `wb` CLI. |
| `packages/mcp` | Thin MCP wrapper over the client (see below). |
| `apps/daemon` | Express API; composes core + store + adapters via `LifecycleService`. |
| `apps/web` | React/Vite dashboard; `/api` only. |
| `scripts/` | Durable tooling: `drive.mjs`, `fix-sqlite-binding.mjs`, `stage-timing.mjs`, `scenarios/`. |
| `scripts/investigations/` | One-off probe/profile/qa scripts kept for reference — not wired into pnpm. |
| `scripts/manual/` | Manual (human-run) test scripts. |
| `archive/` | Frozen v1–v3 predecessors. Ignore during search/discovery. |

## Two ways to drive a task

1. **`wb` CLI** — `pnpm wb <cmd>` (create/show/action/artifact/diff). See the
   `skills/wb-drive` skill for the gate-by-gate procedure. Start `pnpm daemon`
   first.
2. **MCP** (`packages/mcp`) — a thin wrapper over `@workbench/client`; every tool
   delegates to a client method. The server ships an `instructions` preamble
   (`SERVER_INSTRUCTIONS` in `server.ts`) telling the tool-using agent how to
   drive the lifecycle. To enqueue and durably record a feature task: use
   `create_task` + `enqueue_task`, or `create_queue_dag` for a whole DAG in one
   atomic transaction. A dependent runs only once every predecessor reaches the
   terminal `done`.
