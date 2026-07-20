# Agent Workbench v4 — feature inventory

Full list of what v4 actually shipped, grounded in code (not `docs/TODO.md`
aspirations). One section per subsystem; file paths are relative to this
archive folder (`archive/agentic-development-task-system-v4__ai/`).

## Lifecycle engine (`packages/core/src/lifecycle.ts`)

- 14 ordered stages: `intake → task_brief → [human_brief_approval] →
  discovery → [human_plan_approval] → implementation → static_checks →
  feature_e2e → agent_self_review → [human_review] → delivery_prep →
  [human_delivery_approval] → publish → closeout`.
- `isAutoAdvanceable(stage)` excludes the 4 human-gate stages, the terminal
  `closeout`, and `intake`/`task_brief` — a brand-new task stays manual until
  the brief is approved.
- `STAGE_GROUP_LABELS` collapses `static_checks` + `feature_e2e` into one
  **Verification** node in the UI.
- `LIFECYCLE_ACTIONS` (11 actions, incl. `review/bounce --target
  implementation|discovery`) is the single canonical list consumed by daemon
  routes, the `wb` CLI, and the MCP `do_action` enum — one source of truth,
  no drift across the three surfaces.
- Reject/bounce actions require a comment; it's the only feedback the
  regenerated artifact gets.
- `status` (`active → ready_to_publish → done`, or `abandoned` from anywhere)
  is orthogonal to `stage`.

## Agent runtimes (`packages/agents/src/`)

- Four runtimes registered in `PROFILES: Record<AgentRuntime, RuntimeProfile>`
  (`runtime-profile.ts`): `mock`, `claude`, `pi`, `codex`. Each profile
  supplies `createAdapter`, `modelForStage`, `effortForStage`,
  `supportsMidRunGate`, `usesRealWorktree`, `toolDocTier`, `configFields` —
  adding a harness means adding a profile, never an `if (runtime === …)`.
- `STAGE_TOOL_POLICY` (`policy.ts`) is a runtime-neutral per-stage capability
  table, mapped per runtime: `mapPolicyToClaude` (`--allowed/disallowed-tools`
  + `--permission-mode`), `mapPolicyToPi` (`--tools`/`--exclude-tools`),
  `mapPolicyToCodex` (`--sandbox read-only|workspace-write`).
- `ClaudeAgentRuntimeAdapter` wires `--permission-prompt-tool` for mid-run
  human gates and re-admits Linear/Sentry MCP servers for enterprise repos.
- `PiAgentRuntimeAdapter` and `CodexAgentRuntimeAdapter` (live-verified
  against real `pi` 0.80.2 and `codex-cli` 0.142.5) round out real runtimes;
  `MockAgentRuntimeAdapter` returns deterministic canned artifacts with no
  shell/git access, for tests and demos without burning tokens.
- Per-stage model + reasoning-effort routing (cheap models for summarization
  stages, stronger models for discovery/implementation).

## Worktree management (`packages/worktree/src/`)

- `GitWorktreeProvider` runs real `git worktree add -b` / `status
  --porcelain=v1 -b` / `diff HEAD` / `worktree remove`; per-repo creation
  locks (`createLocks`) serialize concurrent worktree creation.
- Deterministic naming: branch `<slug>-<last6ofTaskId>`, worktree path under
  `<dirname(repo)>/.workbench-worktrees/<repo>/<taskId>-<slug>`.
- One task → one worktree → one branch is enforced server-side (`409` if a
  task already has an active worktree).
- A project that targets the workbench's own repo (self-targeting) is forced
  onto a real worktree regardless of any `skipWorktree` config — the main
  checkout is never mutated in place.

## Validation (`packages/validation/src/index.ts`)

- `CommandValidationRunner` runs the project's *real* test/lint/typecheck
  commands via async `spawn` (not `spawnSync`, which was traced as the root
  cause of an ECONNRESET/event-loop-blocking bug — see `docs/econnreset-rootcause.md`),
  with a 32MB output cap and 15-minute default timeout.
- `scopeTestCommand()` rewrites pytest-shaped commands to run only the
  task's changed test files instead of the full suite.
- A failing check parks the task at the Verification stage with the failure
  output attached as evidence.

## Delivery (`packages/delivery/src/index.ts`)

- `GitDeliveryAdapter.publish()` pre-checks for merge conflicts via `git
  merge-tree`, commits all changes, then either opens a PR (push + `gh pr
  create --draft`) or does a real squash-merge (rebase onto base, squash)
  per the project's `DeliveryPolicy`.
- Dry-run is the adapter's default mode (safe by construction); real
  push/merge/PR only happens when a project opts in.
- Re-stages and retries the commit when a pre-commit format hook mutates the
  tree out from under the first attempt.
- Enterprise projects are always seeded with `deliveryPolicy: 'create_pr'`
  (draft PR, never a direct merge to the enterprise repo's main branch).

## Queue / multi-task DAG

- `task_queue` + `queue_dependencies` tables support multi-predecessor
  fan-in, not just linear chains.
- `QueueService` schedules by dependency-eligibility (all `dependsOnIds` at
  terminal `done`) and priority/FIFO order; event-driven `tick()` plus a 30s
  safety poll so nothing silently stalls.
- `create_queue_dag` validates the whole DAG up front (unique ids, valid
  refs, acyclicity via Kahn's algorithm) and inserts every task + edge in one
  atomic SQLite transaction — no partial DAGs on failure.

## Observability

- Structured logging via pino: pretty console output plus daily NDJSON log
  files, with a `runId`-scoped child logger per agent run.
- Per-run token usage and cost parsed from each CLI's own JSON output and
  persisted on the `AgentRun` row (input/output/cache tokens, cost in USD,
  time-to-first-token).
- Pure profiling metrics (`packages/core/src/profiling.ts`) computed from
  persisted events: tool latency, tool-call volume/batching, agent activity
  ratio, repeated-file-read detection, wait-time breakdown, turn/gap stats.
- Stage timing (`packages/core/src/timing.ts` + `scripts/stage-timing.mjs`)
  splits each stage's wall-clock time into real WORK vs WAIT (human-gate
  idle time), so a slow stage can be diagnosed instead of just flagged slow.
- Live streaming over Server-Sent Events: task-level change notifications
  and a full agent-run event replay-plus-live-tail feed (gap-free, resumable
  via a `seq` cursor) that backs the web dashboard's live terminal.

## MCP server (`packages/mcp/src/server.ts`)

- Exposes the whole lifecycle as tools: `list_projects`, `create_project`,
  `list_tasks`, `create_task`, `get_task`, `abandon_task`, `list_queue`,
  `enqueue_task`, `create_queue_dag`, `get_artifact`, `do_action`,
  `worktree_diff`, `get_active_run`, `get_run`, `wait_for_run`,
  `unanswered_questions`, `answer_question`.
- Ships a `SERVER_INSTRUCTIONS` preamble (MCP `instructions`) that teaches a
  tool-using agent the 14-stage lifecycle, gate-reading discipline, and
  DAG-over-loop guidance before it reads any code — the MCP equivalent of a
  CLAUDE.md.
- All closed-set inputs (agent runtime enum, action enum, etc.) are derived
  from `packages/core` so the MCP schema can't drift from the real domain
  types.

## `wb` headless CLI (`packages/client/src/cli.ts`)

- `project`/`task` create/list/show, `task profile` (renders a Markdown
  profiling report for a run), `task artifact` / `task diff`, `task action
  <action>` for gate-by-gate driving, `task drive` (an automated loop through
  every gate up to 32 iterations), `queue` / `queue create <spec.json>` for
  DAG submission from a file.
- Backs both interactive human driving and fully scripted/CI-style runs
  through the same typed `@workbench/client`.

## Web dashboard (`apps/web/src`)

- Task board (`Board.tsx`) with Linear-style gate-centric cards, project
  filter, dependency-state display.
- Task Detail (`TaskDetail.tsx`) — a single-page rail through the lifecycle
  showing artifacts per stage, the live streaming terminal, the full
  worktree diff (`react-diff-view`), and the active gate's approve/bounce
  actions.
- Projects registry page (config-only: name, repo path, build commands,
  agent runtime, delivery policy).
- New Task intake flow, Usage page (token/cost view — recent-runs table
  shipped; deeper analytics explicitly left as a skeleton).
- Real-time updates over SSE — no polling loop in the browser.
- QA image/video artifacts (Playwright screenshots/recordings) embed
  directly in the Human Review panel instead of linking out.

## Per-project memory (`packages/store/src/project-memory-files.ts`)

- One append-only Markdown file per project (`data/project-memory/<projectId>.md`).
- Written at `closeout` (`appendTaskMemory`) summarizing what shipped and why.
- Read back in at `discovery` for that project's next task and inlined into
  the agent's prompt, so cross-task project context isn't reconstructed from
  scratch every time.

## Skills system (`skills/`)

- 18 skill packs: `review-*` (app/fender/py-fastapi/ts-shadcn/security-perf/
  tests/correctness/adversarial), `write-*` (app/fender/readme), `plan-*`
  (app/fender), `qa-artifacts`, `qa-e2e-playwright`, `pr-description`,
  `wb-drive`, `theme-linear`, plus a `_router` for repo-type detection.
- Injected directly into the stage prompt by `packages/agents/src/skills.ts`
  (not via `.claude/skills` auto-discovery, which is disabled for gated CLI
  runs) so skill content can't silently vary by what's on disk.
- A compliance-field contract (`REQUIRED_COMPLIANCE_FIELDS`) is enforced on
  skill output so a stage can tell whether the agent actually followed the
  skill instead of ignoring them.

## Interactive question / ask gate (`apps/daemon/src/question-gate.ts`)

- `QuestionGate.ask()` persists the agent's question, flips the run to
  `awaiting_input`, and blocks on an unresolved promise until a human answers
  via `answer_question` (CLI, web, or MCP).
- Unanswered questions are swept to `interrupted` on daemon restart rather
  than hanging forever on a promise that can never resolve.

## Resumability / crash recovery (`apps/daemon/src/boot-reconcile.ts`, `main.ts`)

- On boot, orphaned `running`/`awaiting_input` agent runs are marked
  `interrupted`; recorded process-group PIDs are verified (liveness +
  identity check) before being `SIGKILL`ed, so a restart can't kill an
  unrelated reused PID.
- Tasks parked at an auto-advanceable stage with no live run are
  automatically re-driven to the next gate on boot (`resumeInterruptedTasks`),
  skipping terminal, still-live, or missing-worktree tasks.
- Built directly in response to a traced `spawnSync`-blocks-the-event-loop
  root cause (`docs/econnreset-rootcause.md`).

## Security / hardening

- Daemon binds to loopback (`127.0.0.1`) by default, not all interfaces.
- Optional shared-secret gate (`WORKBENCH_TOKEN`, bearer or query param,
  compared with `timingSafeEqual`) for any non-default exposure.
- Multi-statement state transitions (task + stage-run insert, whole DAG
  creation) run inside SQLite transactions — no half-applied writes on
  crash.
- Concurrency guards return `409` on double-worktree-creation,
  double-answer, double-abandon, and concurrent-resume races.

## Enterprise repo support (`apps/daemon/src/seed-enterprise.ts`)

- Idempotently seeds real Klaviyo `app`/`fender` projects with correct
  test/lint commands and a forced `deliveryPolicy: 'create_pr'` (always a
  draft PR, never a direct merge).
- Injects an external helper checkout's per-stage "recipe cards" into the
  agent prompt (`klaviyoLocalSeedTool`) so stage guidance stays
  model-agnostic instead of hard-coded per runtime.
- `isEnterpriseProfile` gates extra review skills and enterprise-only MCP
  servers (Linear, Sentry) onto enterprise projects only.

## Demo / recording tooling (`scripts/drive.mjs`, `.claude/skills/run-demo`)

- Two recordable scenarios — `tictactoe` (build a game from scratch in a
  fresh repo) and `enterprise --ticket <id>` (implement any Linear ticket in
  the seeded `app`/`fender` projects, ending on a draft PR).
- Modes: `record` (fresh daemon + Playwright video), `--attach` (record
  against an already-running daemon), `--no-record`, `--dry-run`.
- Records the Workbench dashboard driving the task end-to-end; recording the
  resulting built app/feature itself (as opposed to the dashboard UI) was
  not shipped.
