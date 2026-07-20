# Agent Workbench

A **local-first** control plane and dashboard for managing agentic development
tasks. The Workbench tracks many development tasks as they move through an
explicit, human-gated lifecycle — from raw intake to a publish-ready delivery.

> **What's real.** The control plane, artifact model, task lifecycle, dashboard,
> **real local git worktrees**, **pluggable agent runtimes** for running stage
> agents — a **real Claude adapter** (via the `claude` CLI) and a **real Pi
> adapter** (via the `pi` CLI, including local models through Ollama) — **real
> validation runs** (the project's test/lint/typecheck commands), and **real
> delivery** (commit + push + open a PR via `gh`, defaulting to dry-run) are all
> wired up. The lifecycle can be driven end-to-end against real side effects, and
> `pnpm proof` emits a durable PASS/FAIL artifact bundle proving it. Demo capture
> (Playwright video of the task's own change) is still mocked, and there is no CI yet.

> **Pluggable runtimes.** A project picks its `agentRuntime` (`mock` | `claude` |
> `pi`); each runtime declares its behavior in one `RuntimeProfile`
> (`packages/agents/src/runtime-profile.ts`) — adapter, per-stage model, tool
> mapping, gate support — so the daemon never branches on the runtime. Adding a
> harness is adding a profile. Per-project `runtimeConfig` (model / baseUrl /
> binary) tunes a runtime without code changes; the Pi profile ships proven
> per-stage Ollama model defaults (qwen3-coder for build stages, llama3.2 for the
> heavy review stages), validated by a full end-to-end delivery run.

---

## Architecture

Two processes, a hard browser/daemon boundary, and a set of typed packages. The
same typed client (`@workbench/client`) backs both the browser and a headless
`wb` CLI, so a task can be driven from the dashboard *or* the terminal.

```
┌─────────────────┐                              ┌──────────────────────────┐
│  apps/web        │ ──┐      HTTP (/api)         │  apps/daemon              │
│  React + Vite    │   ├──────────────────────────▶  Express API server       │
│  dashboard       │ ◀─┘ ◀──────────────────────── │  owns FS · SQLite · git   │
└─────────────────┘     JSON only, never shell    └──────────┬───────────────┘
┌─────────────────┐                                          │
│  wb CLI (pnpm wb)│ ──── HTTP (/api) ───────────────────────┤
│  @workbench/     │      same typed client                  │
│  client          │      (WORKBENCH_URL)                    │
└─────────────────┘                                          │
                       ┌──────────────────────────────────────┼───────────────────────┐
                       ▼                ▼               ▼      ▼            ▼            ▼
                 packages/core   packages/store  worktree   agents   validation   delivery
                 domain types &  SQLite +        (stub)     (iface)  (iface)      (iface)
                 lifecycle rules artifact files
```

Key principles, enforced by structure:

- **Local-first only.** No cloud, no auth. Everything runs on your machine.
- **The browser never touches the filesystem, git, or a shell.** It speaks only
  to the daemon over `/api`. The daemon is the single owner of disk + SQLite
  (and, in future increments, git and agent execution).
- **Conversations are non-authoritative.** Durable **artifacts** and **stage
  runs** are the source of truth. Every stage transition is recorded.
- **Domain logic lives in `packages/core`,** not in React and not in route
  handlers. The lifecycle is a set of pure, unit-tested transition functions.
- **One task → one worktree → one branch.** Approving a task's brief creates a
  real git worktree and branch; a task may have only one active worktree at a
  time, and the project's main checkout is never mutated.

### Packages

| Package | Responsibility |
| --- | --- |
| `packages/core` | Domain types, the 16 lifecycle stages, artifact kinds, and **pure transition rules**. No IO. |
| `packages/store` | SQLite persistence (`better-sqlite3`) + artifact **bodies on disk** under `data/artifacts/`. |
| `packages/worktree` | `WorktreeProvider` interface + **`GitWorktreeProvider`** (real `git worktree` create/status/diff/remove) + `StubWorktreeProvider` for tests. Pure branch/path naming rules. |
| `packages/agents` | `AgentRuntimeAdapter` interface + **`MockAgentRuntimeAdapter`** (deterministic, no Claude) **and `ClaudeAgentRuntimeAdapter`** (shells out to the real `claude` CLI, confined to the task worktree) — both return a transcript + produced artifacts. Per-stage tool policy lives here. |
| `packages/validation` | `ValidationRunner` interface + **`CommandValidationRunner`** (runs the project's real test/lint/typecheck commands inside the task worktree, captures output, reports pass/fail/skipped) + an `Unimplemented` stub for tests. |
| `packages/delivery` | `DeliveryAdapter` interface + **`GitDeliveryAdapter`** (commits the worktree branch and — unless `dryRun` — pushes and opens a PR via `gh`) + an `Unimplemented` stub for tests. |
| `packages/client` | **`createClient(baseUrl)`** — the one typed wrapper over the daemon API, shared by the browser and the **`wb` CLI** (`src/cli.ts`). `fetch` is global in both, so no HTTP dependency. |
| `apps/daemon` | Express API. Composes core rules + store + worktree via a `LifecycleService`. |
| `apps/web` | React/Vite dashboard. Talks to the daemon over HTTP only — its `api.ts` is just `createClient('')` (same-origin) from `@workbench/client`. |

### Core entities

`Project`, `Task`, `StageRun`, `Artifact`, `Approval`, `Worktree`, `Job`,
`QueueEntry`, `ValidationRun`, `DeliveryPackage`. (See
`packages/core/src/entities.ts`.)

### Lifecycle

Fourteen ordered stages (`packages/core/src/lifecycle.ts`):

```
intake → task_brief → human_brief_approval → discovery →
human_plan_approval → implementation → static_checks → feature_e2e →
agent_self_review → human_review → delivery_prep →
human_delivery_approval → publish → closeout
```

Approving the brief creates the task's git worktree as a side-effect (not a
stage) and transitions straight to `discovery`. `static_checks` + `feature_e2e`
are consecutive stages that roll up to one **Verification** node in the UI
(`STAGE_GROUP_LABELS`). The pre-change baseline is not a stage either —
Verification captures it lazily, only when a check fails, to tell a new failure
from a pre-existing one.

The four **human gates** are `human_brief_approval`, `human_plan_approval`,
`human_review`, and `human_delivery_approval`. Tasks parked at a gate are
highlighted on the board. `status` is orthogonal to `stage`:
`active → ready_to_publish → done`, or `abandoned`.

Human Review supports three outcomes: **Complete** (→ delivery prep), **Bounce**
(writes a `bounce_packet` and returns to implementation or the plan stage), and
**Abandon** (terminal). Delivery approval **publishes via `GitDeliveryAdapter`**
— it commits the worktree branch and, unless dry-run, pushes and opens a PR via
`gh`, recording the PR URL on the `DeliveryPackage`. The default is **dry-run**
(commit only, no push/PR); a delivery failure is recorded and surfaced rather
than wedging the task.

### Task queue

A `QueueEntry` (one row per enqueued task) lets the scheduler run multiple tasks
concurrently under a dependency DAG. Dependencies are stored as edges (the
`queue_dependencies` table), so an entry can wait on **one or many** predecessors
— chains, fan-out, and fan-in all work. Enqueue via `POST /api/queue` (or the MCP
`enqueue_task` tool) with an optional `dependsOn` (a queue-entry id, or an array
of them) and `priority`. The scheduler runs a `queued` entry once **every**
predecessor in `dependsOnIds` reaches `done`, picking among eligible entries by
priority desc then FIFO; entries with no unmet dependency run in parallel.

A queue entry's `status` (`queued | running | done | failed`) is orthogonal to
the task's own stage/status: `running` means the scheduler has handed the task
to the lifecycle driver (it may be parked at a human gate), and `done` means the
task reached a terminal `done` — **only then does it satisfy a dependent**. If a
task is abandoned or its driver errors, the entry goes `failed`; that failure
doesn't wedge the rest of the queue, but any entry that depends on it stays
`queued` forever (it's waiting for a `done` that never comes). Depend only on
predecessors you expect to reach `done`.

To create a whole DAG at once, `wb queue create <spec.json>` (or the MCP
`create_queue_dag` tool) — a JSON file with a `projectId` and a list of `tasks`,
each with a local `key`, `title`, `request`, optional `priority`, and optional
`dependsOn` referencing sibling keys. The spec is validated (unique keys, known
refs, acyclic), then the whole batch — every task, queue entry, and edge — is
created in **one transaction** (`POST /api/queue/dag`), so a mid-batch failure
rolls back and never leaves a partial DAG.

### Artifacts

Artifact **metadata** lives in SQLite; artifact **bodies** are Markdown files
under `data/artifacts/<taskId>/<artifactId>.md` (the whole `data/` dir is
gitignored). Supported kinds: `raw_prompt`, `task_brief`, `discovery`,
`baseline_evidence`, `execution_plan`, `validation_report`, `demo_evidence`,
`self_review`, `bounce_packet`, `delivery_package`, `closeout_summary`, `log`,
`diff`.

### Worktrees

When a task's brief is approved, the daemon creates **one branch and one git
worktree** for it via `GitWorktreeProvider` (`git worktree add -b <branch>
<path> <base>`). The project's own checkout is never touched.

- **Branch:** `wb/<task-id>-<slug>` (slug derived from the task title).
- **Worktree path:** `data/worktrees/<project-slug>/<task-id>-<slug>`
  (under the gitignored `data/` dir).
- **Base branch:** the project's default branch; recorded on the worktree.
- **One active worktree per task.** Asking for a second active worktree is
  rejected (HTTP 409).

Worktree metadata (path, branch, base branch, status) lives in the
`worktrees` table in SQLite. Status is `created` → `preserved` (kept on disk)
or `abandoned` (worktree + branch removed). The Task Detail page surfaces the
path/branch/base/git-status and offers: **create worktree**, **refresh git
status**, **show changed files**, **show diff**, **preserve**, and **abandon**.

> The `worktree add`/`status`/`diff`/`remove` calls run synchronously against
> the local git binary; the daemon is the only process that touches git.

### Agent runtime (mock + Claude)

`packages/agents` defines the `AgentRuntimeAdapter` abstraction for running a
stage-specific agent:

```
runStageAgent(input) -> result
```

- **Input:** task id, stage, worktree path (if available), context packet
  artifact ids, and an allowed-tool policy (plus the task title/raw request).
- **Result:** a transcript artifact, the produced artifact ids, a status
  (`succeeded` / `failed`), and an error when it failed.

Both adapters are **pure compute**: they return content and never touch SQLite,
disk, or git directly. The daemon persists the transcript as a `log` artifact
and stores each produced artifact, keeping the browser→daemon→disk boundary
intact. Running an agent **does not advance the lifecycle** — a human still
clicks the stage action to gate the task forward.

#### Choosing a runtime per project

Each project has an `agentRuntime` setting (`mock` | `claude`, default `mock`),
chosen on the **New project** form. The daemon picks the adapter per run from
the task's project.

- **`MockAgentRuntimeAdapter`** — deterministic, generates four canned stage
  outputs (**Task Brief**, **Discovery**, **Execution Plan**, **Self Review**)
  plus a simulated transcript. No network, no Claude.
- **`ClaudeAgentRuntimeAdapter`** — shells out to the locally-installed
  [`claude` CLI](https://code.claude.com/docs/en/claude-code) in non-interactive
  print mode (`claude -p … --output-format json`). It:
  - uses your **existing Claude Code login** — **no `ANTHROPIC_API_KEY` needed**
    (it does not use `--bare`, which would force API-key-only auth);
  - **only operates inside the task worktree** — the CLI is spawned with
    `cwd = worktree path` and no `--add-dir`, so the worktree is the only root;
    with no worktree it refuses to run;
  - receives a **stage packet** (`claudeStagePrompt`, passed as the `-p` prompt)
    — the current stage's instruction + task title/request + context artifact
    ids — **not** the full task history;
  - **produces structured output** where possible: the agent ends its reply with
    a fenced `json` block, which is parsed and stored as a structured artifact
    alongside the full prose;
  - stores the **full transcript** as a `log` artifact: the (redacted)
    invocation, exit code, result subtype, turns, cost, permission denials, the
    final output text, and any stderr.
  - The binary and model are overridable via `WORKBENCH_CLAUDE_BIN` /
    `WORKBENCH_CLAUDE_MODEL`.

#### Per-stage tool policy

`STAGE_TOOL_POLICY` (in `packages/agents`) maps each stage to `claude` CLI flags.
**`--allowed-tools` is only an auto-approval allowlist** — in `-p` mode the model
can still attempt tools that aren't on it — so the real read-only boundary is
**`--disallowed-tools`** combined with `--permission-mode plan`:

| Stage | `--permission-mode` | `--disallowed-tools` (hard) | `--allowed-tools` |
| --- | --- | --- | --- |
| `task_brief` | `plan` | Bash, Edit, Write, NotebookEdit | Read, Grep, Glob |
| `discovery` | `plan` | Bash, Edit, Write, NotebookEdit | Read, Grep, Glob |
| `options_plan_test` (planning) | `plan` | Bash, Edit, Write, NotebookEdit | Read, Grep, Glob |
| `implementation` | `acceptEdits` | (none) | Read, Edit, Write, Bash |
| `agent_self_review` | `default` | Edit, Write, NotebookEdit | Read, Grep, Glob, Bash |

`POST /api/tasks/:id/agent/:stage` triggers a run (400 for unsupported stages).
The Task Detail page has a **stage agent** card with a button per runnable
stage. **No delivery or PR creation in this increment.**

---

## Local setup

Requires **Node ≥ 20** and **pnpm 10**.

```bash
pnpm install
```

`better-sqlite3` is a native module. If its binding fails to build on install,
download the prebuilt binary once:

```bash
pnpm rebuild better-sqlite3
```

### Run it

Two terminals (the web dev server proxies `/api` to the daemon):

```bash
# terminal 1 — local daemon API on http://localhost:4417
pnpm daemon

# terminal 2 — dashboard on http://localhost:5317
pnpm web
```

Seed one example project + one example task (idempotent):

```bash
pnpm seed
```

Then open **http://localhost:5317**.

### Run it with Docker

One command brings up both processes — no local Node/pnpm needed, just Docker:

```bash
docker compose up            # daemon (:4417) + web (:5317)
```

Seed one example project + task (idempotent, one-shot):

```bash
docker compose run --rm seed
```

Then open **http://localhost:5317**. Stop with `docker compose down` — your
SQLite DB, artifacts, and worktrees persist in `./data` (bind-mounted), so the
next `up` picks up where you left off. Override ports / the claude binary via a
`.env` file (copy `.env.example`).

> **Host-CLI caveat.** The daemon shells out to the host's `git`, `gh`, and
> `claude` CLIs and creates real git worktrees under `data/worktrees/`. Inside
> the container the dashboard and the **mock** agent runtime work fully, but the
> **`claude` runtime**, **`gh`-backed delivery**, and **real-worktree** flows are
> not wired up by default — they need the host CLIs + logins. See the comment
> block in `docker-compose.yml` for how to mount `~/.claude` / `gh` config if you
> want to experiment with them. For the full claude/delivery path, run natively
> (the two-terminal flow above).

### Drive it headless (`wb` CLI)

The dashboard is one way to drive a task; the **`wb` CLI** (`@workbench/client`,
the same typed client the browser uses) is the other. It talks to a running
daemon over `/api` — start `pnpm daemon` first. The base URL comes from `--url`,
then `WORKBENCH_URL`, then `http://127.0.0.1:4417`.

```bash
pnpm wb projects                       # list projects (also a daemon health check)
pnpm wb project create --name N --repo /abs/path --branch main \
  --runtime claude --test "pnpm test" --typecheck "pnpm typecheck"
pnpm wb tasks                          # list tasks
pnpm wb task create --project <pid> --title "…" --request "…"
pnpm wb task show <id>                 # stage, status, and artifact ids
```

Two ways to clear the four human gates:

- **`pnpm wb task drive <id>`** — fire-and-forget: approves every gate
  **blindly**, in sequence, without reading artifacts. Right for a smoke run or a
  mock-runtime task you trust.
- **Gate-by-gate** — read before you decide, then act. This is what the
  [`wb-drive`](skills/wb-drive/SKILL.md) skill automates from a Claude Code
  session for real (`claude`-runtime) tasks:

  ```bash
  pnpm wb task action <id> generate-brief        # → parks at human_brief_approval
  pnpm wb task artifact <artifactId>             # read the brief / plan body
  pnpm wb task diff <id>                          # read the worktree diff (at review)
  pnpm wb task action <id> approve-brief          # or approve-plan / review/complete / approve-delivery
  pnpm wb task action <id> reject-brief --comment "…"   # bounce with required feedback
  ```

> The daemon enforces every gate and legal move regardless of who's driving — the
> CLI cannot bypass a gate or skip an open mid-run question. A **self-targeting**
> project (its `repoPath` is the daemon's own checkout) additionally **refuses the
> skip-worktree path**: every task there gets an isolated worktree, so an agent
> can't edit the code or SQLite DB driving its own run.

### Verify it's green

Run these from the repo root, in order:

```bash
pnpm typecheck   # tsc --noEmit across every package
pnpm build       # compile packages/* (the daemon imports their dist/)
pnpm test        # full unit/integration suite (vitest)
pnpm proof       # end-to-end run → bundle + PASS/FAIL verdict (exits non-zero on FAIL)
```

### End-to-end walkthrough (Playwright)

The e2e test auto-boots an **isolated** daemon + Vite dev server on throwaway
ports, runs the full UI walkthrough headless, and records video/trace/report to
`apps/web/e2e-artifacts/`. Chromium is needed once:

```bash
pnpm --filter @workbench/web exec playwright install chromium
```

```bash
pnpm test:e2e    # the walkthrough (alias for the playwright command below)
pnpm test:all    # full unit suite + the e2e walkthrough

# equivalent / for iterating:
pnpm --filter @workbench/web exec playwright test                 # all steps, headless
pnpm --filter @workbench/web exec playwright test --headed        # watch in a real browser
pnpm --filter @workbench/web exec playwright test walkthrough.spec.ts:161  # a single step
pnpm --filter @workbench/web exec playwright show-report apps/web/e2e-artifacts/report
```

> **Worktrees don't share `node_modules`.** If you run any of these from a git
> worktree of this repo, `pnpm install --frozen-lockfile` there first. From the
> main repo you can target a worktree without `cd`-ing into it by prefixing the
> path: `pnpm -C <worktree-path> …`.

---

## Screens

1. **Task Board** (`/`) — tasks grouped by current stage; a banner highlights
   tasks waiting on human approval.
2. **Project Registry** (`/projects`) — create/list projects with repo path,
   default branch, delivery policy, and test/lint/typecheck/e2e/dev commands.
3. **New Task / Intake** (`/new`) — pick a project, enter a raw request, create
   a task (starts in Intake).
4. **Task Detail / Timeline** (`/tasks/:id`) — the lifecycle timeline, artifacts
   per stage, current status, the stage-appropriate actions, a **Worktree
   card** (path/branch/base/git-status with create · refresh · diff · preserve ·
   abandon), and an "add mock artifact" affordance. Click any artifact chip to
   read its body.
5. **Approval actions** are surfaced inline on the Task Detail page for each
   gate (approve/reject brief, approve/reject plan, Human Review
   Complete/Bounce/Abandon, approve/reject delivery).

---

## A demo path through the mock lifecycle

After `pnpm seed`, open the seeded task ("Add dark mode toggle to settings") and
click through:

1. **Generate Task Brief** → parks at *Human Brief Approval* (writes
   `raw_prompt` + `task_brief`).
2. **Approve Brief** → advances to *Discovery* and creates the task's real git
   worktree + branch (`wb/<task-id>-<slug>`). Requires the project's `repoPath`
   to point at a real git repo on the default branch.
3. **Discovery** (auto) → *Options + Execution Plan + Test Plan*.
4. **Submit Execution Plan** → parks at *Human Plan Approval* (writes
   `execution_plan`).
5. **Approve Plan** → *Implementation*.
6. **Mark Implementation Complete** → *Verification*.
7. **Verification** → runs the project's real test/lint/typecheck
   commands in the worktree and writes the captured output into
   `validation_report` (+ mock `demo_evidence`). If any command **fails the task
   parks here** instead of advancing; on success → *Agent Self-Review*.
8. **Complete Self-Review** → *Human Review*.
9. **Complete** → *Delivery Preparation* (or **Bounce** to send it back with a
   `bounce_packet`, or **Abandon**).
10. **Prepare Delivery Package** → parks at *Human Delivery Approval*.
11. **Approve Delivery** → publishes via `GitDeliveryAdapter` (commits the
    branch; pushes + opens a PR unless dry-run, recording the PR URL) → *Publish*.
12. **Closeout** → status **done** (writes `closeout_summary`).

The same intake→closeout path is exercised automatically by the daemon
integration tests (`apps/daemon/src/lifecycle-smoke.test.ts` is the consolidated
happy-path walk; `app.test.ts` covers the HTTP layer).

---

## Not yet built

- **Demo capture** — `demo_evidence` is still a mock artifact; nothing yet
  records a Playwright video of the *task's own* change (the e2e walkthrough
  records the Workbench UI, not the task under development).
- **CI** — there is no `.github/workflows`. `pnpm proof` is designed to double as
  the CI gate (it exits non-zero unless the run reaches closeout with passing
  validation and a non-failed delivery), but nothing runs it on push yet.
- **Cloud / auth.** Local-first by design — no remote deployment, no auth.

## Future increments

- Record real demo evidence (Playwright video of the task's change).
- Add CI that runs the test pyramid + a mock/dry-run `pnpm proof` on every PR.
```
