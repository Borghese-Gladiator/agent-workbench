# Agent Workbench

Agent Workbench is a small local orchestrator for turning a messy software idea into an isolated git worktree, implementation artifacts, validation evidence, and a human-reviewable branch.

It is intentionally not a general multi-agent platform. A run has one target repo, one branch, one worktree, and one audit trail.

## Core model

- One run targets one repo path.
- The repo may already exist, or the run may create a new repo at a user-provided path.
- Agent Workbench does not maintain a global repo registry.
- For new app repos, monorepo layout is the default.
- V1 creates local branches and local worktrees only.
- V1 does not create PRs, merge branches, or coordinate changes across multiple repos.
- All implementation happens inside a worktree under Agent Workbench.

Worktrees are created here:

```text
agent-workbench/worktrees/<repo_name>/<worktree_name>/
```

The original repo can live anywhere:

```text
/Users/me/code/random-existing-repo
/Users/me/projects/new-product
/tmp/scratch/prototype
```

## Lifecycle

```text
draft -> shaping -> planning -> ready -> building -> validating -> human_review -> done
```

Any non-terminal state can move to:

```text
abandoned
```

The only state that may ask the human clarifying questions is `draft`.

After `draft`, the agent must either proceed, record assumptions, or stop with evidence. It should not keep reopening vague chat loops.

## Main commands

The command names are conceptual. Implementations may add flags, but should preserve the same lifecycle semantics.

```text
agent-workbench new-run
agent-workbench shape
agent-workbench plan
agent-workbench start
agent-workbench validate
agent-workbench handoff
agent-workbench complete
agent-workbench bounce
agent-workbench abandon
```

Typical existing-repo flow:

```text
agent-workbench new-run --repo-path /Users/me/code/app --worktree-name add-login-form
agent-workbench shape <run_id>
agent-workbench plan <run_id>
agent-workbench start <run_id>
agent-workbench validate <run_id>
agent-workbench handoff <run_id>
```

Typical new-repo flow:

```text
agent-workbench new-run --new-repo-path /Users/me/projects/shogi-go-app --worktree-name bootstrap
agent-workbench shape <run_id>
agent-workbench plan <run_id>
agent-workbench start <run_id>
agent-workbench validate <run_id>
agent-workbench handoff <run_id>
```

## Repository and worktree behavior

For an existing repo:

```bash
git -C /Users/me/code/app worktree add \
  -b agent/add-login-form \
  /path/to/agent-workbench/worktrees/app/add-login-form \
  HEAD
```

For a new repo, Agent Workbench creates the repo at the user-provided path, initializes git, creates an initial commit, then creates the isolated worktree under the workbench.

Implementation never happens directly in the original checkout.

## Run artifacts

Each run owns a directory under `runs/`:

```text
runs/<run_id>/
  metadata.yaml
  events.jsonl
  raw-idea.md
  answers.md
  brief.md
  plan.md
  preflight.md
  assumptions.md
  decisions.md
  implementation-summary.md
  diff-summary.md
  review.md
  qa/
    report.md
    commands.txt
    artifacts/
    recordings/
    traces/
  audit.md
  handoff.md
```

`metadata.yaml` stores current state and pointers to artifacts.

`events.jsonl` is the append-only machine log.

`audit.md` is the human-readable explanation of how the run reached its current state.

## Audit guarantee

Every meaningful transition requires evidence.

Before implementation starts, the run must already have:

- `brief.md`
- `plan.md`
- `preflight.md`
- `assumptions.md`
- `decisions.md`

After implementation and validation, the run must have:

- `implementation-summary.md`
- `diff-summary.md`
- `review.md`
- `qa/report.md`
- `audit.md`
- `handoff.md`

The audit must show:

- the original request
- the target repo path
- the branch and worktree created
- assumptions made before implementation
- decisions made before implementation
- commands run
- changes made
- validation performed
- failures and recoveries
- final handoff or completion evidence

## Scope policy

Agent Workbench should reduce scope aggressively, but not unnecessarily.

If the idea is clear enough to implement, it may start implementing after the `ready` gate.

If the idea is broad or ambiguous, shaping should produce a smaller first run, such as a bootstrap, roadmap, or vertical slice.

Examples:

```text
Clear enough: Add a health endpoint and WebSocket echo endpoint to this Go service.
Too broad: Build a complete multiplayer Shogi app with engine, backend, frontend, accounts, and deployment.
```

The broad idea should become a scoped first run unless the user explicitly asks for a specific implementable slice.

## V1 non-goals

- No GitHub PR creation.
- No merge automation.
- No multi-repo runs.
- No background execution promises.
- No global repo registry as source of truth.
- No durable state for every internal substep.
- No direct mutation of the original checkout during implementation.

## Design principle

Use states for ownership and waiting points, not for every action.

A compact state machine plus strong artifacts is easier to reason about than a large orchestration graph with weak evidence.
