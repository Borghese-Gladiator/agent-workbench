# Archive — five generations of an agentic dev-task system

Each version folder has the same layout. The root holds the docs: `README.md`, `docs/`, and any `FEATURES.md`, `LOG.md`, or `CLAUDE.md`. The `code/` folder holds everything else. To look back, read the root docs first.

Each folder below is a **frozen, self-contained snapshot** of a full attempt at the
same underlying problem: let an AI agent implement a feature end-to-end against a
real repo, without the result being unreviewed, unaudited, or untrustworthy. None of
these folders are wired into any build — they exist purely as a paper trail for what
was tried, why it stopped being enough, and what the next version kept or discarded.
Full commit-by-commit history is in
[`agentic-development-task-system-v4__ai/LOG.md`](agentic-development-task-system-v4__ai/LOG.md) (v1-v4) and
[`agentic-development-task-system-v5__ai/LOG.md`](agentic-development-task-system-v5__ai/LOG.md) (v5).

## v1 — `agentic-development-task-system-v1__ai`

A Kanban board (Express + Vite/React + SQLite) for tracking AI-assisted dev work:
issue ingestion, epics/initiatives, terminal session management, activity logging.
Built before discovering Vibe Kanban and similar off-the-shelf tools — in hindsight,
largely reinventing a generic project-tracker rather than solving anything specific
to *agentic* development.

**Why it was replaced:** it only tracked status. It had no opinion about *how* an
agent should do the work — no worktree isolation, no forced planning step, no audit
trail of what the agent decided and why, no automated QA. Two tasks running against
the same repo could stomp on each other. The board told you a task was "in
progress"; it couldn't tell you what the agent had actually done or whether the
result was safe to merge.

## v2 — `agentic-development-task-system-v2__ai`

A markdown-and-shell-script control plane (`ai-workbench`): a standalone orchestration
repo that never touches the product repo's own history. Every run gets a
`runs/<run_id>/` directory with templated artifacts (`spec.md`, `decisions.md`,
`run-log.md`, `qa-log.md`, `pr-summary.md`) and its own disposable `git worktree` +
branch. Slash commands (`/new-run`, `/plan`, `/start`, `/complete`, `/bounce`)
drove a human-gated state machine, later extended with `gh` CLI integration for real
PR creation and CI-check polling.

**What this fixed over v1:** decisions now had a durable, reviewable record instead
of living only in chat transcripts; worktrees gave real concurrency and clean
rollback; the orchestration repo stayed decoupled from product repos so build
tooling never had to know an agent existed.

**Why it was replaced:** the whole system was markdown templates + bash/Python
glue plus a human driving slash commands one at a time — there was no execution
engine that could **run multiple sessions for the same task** and stitch them
together, no automatic QA (validation was "a human clicks through it"), and adding
a new product repo meant hand-editing `config/repos.yaml` and re-validating by
hand. First-draft agent implementations were often unusable without heavy manual
rework, and the system had no way to force a redo loop.

## v3 — `agentic-development-task-system-v3__ai`

A second, parallel rebuild of the same idea (`202605_agent_workbench_v2`), imported
into this repo alongside v2's history rather than branched from it. Kept v2's
markdown-artifact-per-run philosophy but added a live Textual TUI task board on top
of `runs/`, per-run token-efficiency tracking, a structured `HUMAN_REVIEW.md`
handoff format, and — notably — an explicit five-axis classification of its own
architecture (subagent topology, context strategy, tool bounding, safety/approval
model, orchestration style) against the taxonomy in arXiv:2604.18071, making the
design tradeoffs explicit instead of implicit.

**What this fixed over v2:** much tighter TODO/LOG discipline (every shipped item
cross-referenced its commit SHA), a real live board instead of static files, and
starting to reason explicitly about agent-safety axes (isolation, approval,
audit) rather than ad hoc.

**Why it was replaced:** still fundamentally a CLI you drove by hand, stage by
stage, with **low observability** — you could see the current chat status but not
which lifecycle stage a run was actually in, or whether a stage could be retried
independently. There was no server/API, no dashboard, no MCP surface for another
agent to drive it programmatically, and quality gates were still mostly manual
discipline rather than something the system enforced structurally.

## v4 — `agentic-development-task-system-v4__ai`

A from-scratch TypeScript monorepo: a local daemon (Express API) owning SQLite +
disk + git, a pure `packages/core` lifecycle engine (14 ordered stages with 4
human-gated checkpoints), pluggable `RuntimeProfile`-driven agent adapters
(claude/pi/codex — adding a harness is data, not an `if` branch), real validation
(the project's actual test/lint/typecheck) and delivery (`git` + `gh` PR) adapters,
a React/Vite dashboard, an MCP server so another agent can drive the whole lifecycle
as tools, and a headless `wb` CLI. One task always maps to one worktree and one
branch; the browser never touches the filesystem, git, or a shell — only the daemon
does, over `/api`.

**What this fixed over v3:** the lifecycle became a real state machine enforced in
code (`packages/core/src/lifecycle.ts`), not a convention a human had to remember —
gates structurally cannot be skipped by an agent, because crossing one is a daemon
action, not something a running session can do. Verification is real command
execution (not a human eyeballing a diff), self-review is an adversarial pass
before a human ever sees the diff, and the MCP server + `wb` CLI give two first-class
programmatic ways to drive the whole thing, including whole dependency DAGs of
tasks in one atomic transaction.

**Why it was archived:** the lifecycle-and-tooling shape has stabilized — bounce
loops converge, gates hold, three real runtimes are live, delivery produces real
PRs — but the harder problems that remain (bounded review-bounce budgets on
persistent disagreement, boot-time crash recovery being only half-hardened, no
periodic liveness watchdog, agent quality still gated by prompt/skill discipline
rather than anything structural) call for a different shape of investment than
"add another stage." v4 is frozen here as a complete, working reference rather
than because it failed the way v1-v3 did — see its own
[`LOG.md`](agentic-development-task-system-v4__ai/LOG.md) for the exact commit
trail and [`README.md`](agentic-development-task-system-v4__ai/README.md) /
[`CLAUDE.md`](agentic-development-task-system-v4__ai/CLAUDE.md) for the full
architecture as it stood at freeze time.

Why it was archived
- QA for tasks was not thorough enough to fully validate it was working
- QA artifacts were different every time, so it was difficult to use and validate. I want an actual webm video or screenshot. Since it was entirely reliant on the model, it was RNG if it produced something that I could use to actually verify functionality
- Lifecycle stages were not enforced well enough. Tasks would move through towards completion
- Retries reran with the entirety of the cached tokens and increased costs by a decent amount

## v5 — `agentic-development-task-system-v5__ai`

The "Agentic Workbench" (`awb`). A TypeScript monorepo of about 19 packages: a
daemon, a Temporal worker, a web UI, and an `awb` CLI. A task ran through nine
fixed lifecycle phases, and each phase had its own completion rule, routing rule,
and cache rule. Runtime profiles (claude, codex, pi, opencode) were data, not
code branches. The system ran many tasks at the same time and delivered each one as
a draft PR. The last work removed every human gate so a task looped to a draft PR
alone. Full detail is in [`README.md`](agentic-development-task-system-v5__ai/README.md),
[`AGENTS.md`](agentic-development-task-system-v5__ai/AGENTS.md), and
[`FEATURES.md`](agentic-development-task-system-v5__ai/FEATURES.md).

**What this fixed over v4:** v5 added durable workflows that survive a crash,
a read-back of real phase and session timing, fleet-level monitoring, a
multi-adapter runtime layer, and real QA with browser media. Ordinary runs
reached a draft PR without a human at each gate.

**Why it was archived:** v5 did not fail on features. It cost too much to run and
to keep correct. A rebuild ([`PROPOSAL.md`](../PROPOSAL.md))
replaces it. The reasons are below.

- **Runtime.** The system needed Temporal, a daemon, a worker, and a web server
  at the same time. Ports, queues, and stale `dist` builds broke boot often. Ten
  concurrent tasks pushed the host load to about 377. A network partition wedged
  the worker.
- **Very wasteful with tokens.** Cost came from the context inside each session,
  not from the prompt preamble. Every phase started a new session and rebuilt
  context. A retry replayed the full cached context. The measured audits are in
  `docs/token-cost-measurement.md` and `docs/task-79-prompt-token-audit.md`.
- **Wrong validation from lifecycle stages.** Each fixed phase made its own
  decision about "done". Gates passed on agent completion, not on test results.
  Static string checks accepted runtime bugs. One QA executor always passed. A
  task could reach a PR without proof that the feature worked.
- **Better models.** Current models follow instructions much better. They do not
  need a rigid phase machine to stay on task. A short playbook of exact steps now
  gives the same control with far less code.
- **Too many moving parts.** The phase table, workflow, completion function, and
  a 2,172-line `run-phase.ts` hub all had to change together for one new step.
  Many parts made failures hard to trace and debug. A bug could sit in Temporal,
  the daemon, the worker, the database, or the adapter.

The v6 plan keeps one hard rule in code: no PR claims a feature works without
proof. It targets less than half the code, no Temporal, no worker, and one small daemon for the UI.
