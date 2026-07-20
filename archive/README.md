# Archive — four generations of an agentic dev-task system

Each folder below is a **frozen, self-contained snapshot** of a full attempt at the
same underlying problem: let an AI agent implement a feature end-to-end against a
real repo, without the result being unreviewed, unaudited, or untrustworthy. None of
these folders are wired into any build — they exist purely as a paper trail for what
was tried, why it stopped being enough, and what the next version kept or discarded.
Full commit-by-commit history for all four is in
[`agentic-development-task-system-v4__ai/LOG.md`](agentic-development-task-system-v4__ai/LOG.md).

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