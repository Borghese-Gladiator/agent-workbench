# Architecture

Agent Workbench is a local run orchestrator for coding agents.

It coordinates artifacts, state transitions, local git worktrees, validation, and audit logs. It does not own the user's repos and does not require GitHub.

## Design goals

- Keep the lifecycle small and explicit.
- Use evidence-bearing transitions.
- Keep each run scoped to one repo and one worktree.
- Store decisions and assumptions before implementation starts.
- Make all implementation happen outside the original checkout.
- Produce a human-readable audit after validation.
- Prefer markdown artifacts over hidden state.

## Non-goals for V1

- No PR creation.
- No branch merging.
- No remote hosting assumptions.
- No global repo registry.
- No multi-repo runs.
- No background jobs that promise later delivery.
- No complex agent marketplace or routing system.

## Classification

Classified against the five-axis multi-agent taxonomy from [Wang et al., *agents are stateful operating systems, not just prompts* (arXiv:2604.18071)](https://arxiv.org/abs/2604.18071).

| Axis | Picked | Not picked |
| --- | --- | --- |
| **Subagent architecture** | orchestrator-worker; role-specialized agents | single agent; tool-mediated pseudo-subagents; recursive hierarchy; peer/swarm |
| **Context — storage** | file-persistent memory | context-window only; session-only; database-backed; vector/RAG |
| **Context — compression** | event/task summaries; hierarchical summaries | none; rolling summary; extractive |
| **Context — retrieval** | explicit file reads; grep / lexical; git-aware | recent turns; symbol index / repo map; embedding search |
| **Context — budgeting** | hard caps per source | fixed truncation; priority buckets; dynamic budgeting |
| **Context — reintroduction** | on-demand context; path-scoped inject | always inject; retrieval-based inject; user-pinned |
| **Tools — registration** | hard-coded; MCP / protocol-based (delegated to host) | decorator/function registry; manifest-based; plugin system |
| **Tools — discovery** | static tool list | capability-scoped; contextual; tool search |
| **Tools — invocation** | plan-then-call; harness-mediated; deterministic hooks | direct model tool call |
| **Tools — bounding** | workspace-only filesystem; read/write separation; timeout/output caps | no bounds; shell allowlist/denylist; network restrictions; capability tokens |
| **Tools — extension** | local project tools; MCP servers (via host) | built-ins only; user-installed plugins; org-managed plugins |
| **Safety — approval** | policy-based approval; human-in-the-loop checkpoints | no approval; approve all; risk-tiered; mode-based |
| **Safety — isolation** | workspace path restriction | no isolation; process-level; container; VM/microVM; network sandbox; secrets isolation |
| **Safety — audit** | structured event log; diff-based audit; replayable trace | none; basic logs; tamper-evident |
| **Safety — additional** | write boundary; dependency boundary; final diff review | prompt-injection handling; dangerous command classifier |
| **Orchestration** | state machine; plan-act-review; human checkpoint orchestration | simple request-response; ReAct loop; plan-and-execute; declarative workflow; event-driven; hierarchical planning; autonomous bounded loop |

Implementation pointers: lifecycle FSM in [`agent-workbench-live/schemas/transitions.yaml`](agent-workbench-live/schemas/transitions.yaml); transition engine in [`agent-workbench-live/lib/transitions.py`](agent-workbench-live/lib/transitions.py); event log schema in [`agent-workbench-live/schemas/events.jsonl`](agent-workbench-live/schemas/events.jsonl); subagent + session discipline in [`agent-workbench-live/AGENTS.md`](agent-workbench-live/AGENTS.md).

## Why orchestration is centralized

Most AI-coding setups scatter planning artifacts across the product repos themselves: a `/specs` folder here, an `/ai/notes` folder there, decision docs buried in random PR descriptions. Three problems follow:

1. **The product repo's history gets noisy.** Every spec revision is a commit in a tree where humans are trying to read code changes.
2. **Cross-repo context is impossible.** A feature that touches frontend + backend needs one shared planning home. Scattering it across two repos splits the memory.
3. **Source code accidentally inherits orchestration concerns.** Build pipelines, linters, and code search tools start to trip over `/ai` or `/runs` folders.

Agent Workbench inverts the relationship: orchestration is its own workspace, product repos are downstream consumers. The product repos never know Agent Workbench exists; they just see well-formed feature branches arrive.

The workbench root is the **integration target**, not the **runtime artifact store**. Live runs live in their worktrees while in flight; the auto-merge that runs at `complete`/`abandon` is the archival path that delivers the run dir onto master. This keeps master's working tree clean during multi-run sessions — two parallel runs can land their feature branches into master without ever needing a `git stash` between them. The detection helper is `lib.runs.is_self_modifying(cfg, meta)` (true iff the workbench checkout is inside the target repo); for non-self-modifying runs against an unrelated product repo, the run dir continues to live in the workbench checkout's `runs/` for the whole lifecycle, since master's working tree of an unrelated repo isn't a sharing concern.

## Why worktrees are isolated

Every run gets a fresh worktree at `worktrees/<repo_name>/<worktree_name>/`, checked out from the product repo. Reasons:

- **Concurrency.** Multiple runs against the same product repo can coexist. Git worktrees are explicitly designed for this.
- **Clean rollback.** If a run is abandoned, removing the worktree and deleting the branch leaves zero residue in the product repo's working tree.
- **Reproducibility.** A worktree pinned to `<base_ref>` at run-creation time gives a stable starting point that won't drift while we plan.
- **Agent safety.** An agent confined to a worktree cannot accidentally trample the user's main checkout of the product repo.

We deliberately **do not** clone product repos. Worktrees share the same `.git` directory as the source repo, so they're cheap and consistent with the user's existing remotes, hooks, and config.

## Why metadata.yaml is canonical

Every run directory has a `metadata.yaml` that records:

- `run_id`, `status`, `scope`
- `target.repo` (mode, path, name, base_ref)
- `target.worktree` (name, path, branch_name)
- pointers to every artifact
- `created_at`, `updated_at`

This file — not the directory name, not the branch name, not the worktree state — is the source of truth. Reasons:

- **Directory names are lossy.** A path like `runs/2026-05-18-add-login-form/` doesn't tell you which product repo the run targets, what status it's in, or which branch was created. Parsing it would force conventions to leak into code.
- **Filesystem state is mutable.** Worktrees can be removed, branches deleted, runs archived. We need a stable record of intent that survives those operations.
- **Tooling stays decoupled.** Any script — current or future — that needs to know "what is this run?" reads `metadata.yaml`. No regex on path components, ever.

The transition engine is the only thing that should write `status` and append `TransitionApplied`. Manual edits to `metadata.yaml` are not valid transitions.

## Why Python helpers, not pure bash

Use bash for orchestration glue (process control, git invocations, exit codes) but Python for any structured parsing — specifically YAML reading/writing for `metadata.yaml` and `agent-workbench.yaml`. Reasons:

- **YAML is fragile under bash.** `awk`/`sed` parsing breaks on quoting, comments, multi-line values. A 50-line Python helper is more robust than a 10-line awk pipeline.
- **No external deps.** Prefer Python's stdlib only (no `PyYAML`, no `yq`). The YAML we emit is a tiny flat subset, and a small reader handles exactly that subset. This keeps init zero-install on any machine with Python 3.
- **Testable.** Helpers are importable; behavior can be exercised independently of the shell scripts.

## Why slash commands for the agent-bearing steps

Most workbench operations are deterministic plumbing — `git worktree add`, status flips, file copies. Those live in `scripts/` as bash, where they belong.

Some steps are not deterministic: shaping a brief from raw input, planning against a real repo, running an adversarial review, stitching a handoff summary. None of those are available outside an active Claude Code session — MCP servers and skills are session-scoped.

The fix is to expose those steps as slash commands under `.claude/commands/`, so the user is already in a Claude Code session when they invoke them. Slash commands inherit the session's MCP auth and can call the Skill tool in-process. The deterministic prefix moves into a Bash block at the top of the markdown; the LLM-bearing step lives in the body. Same code, no context-switch.

This isn't a relaxation of "Agent Workbench is the substrate for agent work, not the agent" — the workbench still doesn't embed an agent. It just publishes the slash commands an agent (in any Claude Code session) can invoke against a workbench checkout.

## Subagent discipline

The workbench's "multi-agent" model is **not** a per-stage worker process pool, a job queue, or a long-running daemon. It is a discipline about *how slash commands compose their work inside a single Claude Code session*.

Three rules:

### 1. The master session is the orchestrator and owns lifecycle state.

Only the master session reads and writes `runs/<run_id>/metadata.yaml`, appends to `events.jsonl`, and calls the transition engine. Lifecycle state is single-threaded by construction. Subagents never mutate metadata directly — they return findings to the master, which then decides whether to advance status.

### 2. Subagents handle parallelizable work via the Agent tool.

When a slash command needs to do `N` similar pieces of work that don't depend on each other — exploring `N` candidate approaches, reviewing `N` worktrees, drafting `N` summaries — it spawns `N` subagents in a single tool-use turn so they run concurrently. The master collates the results into one artifact.

### 3. Subagents are scoped via the narrowest Agent type that fits.

Claude Code's Agent tool exposes agent types with different tool allowlists (Explore = read-only search; Plan = read-only with planning tools; general-purpose = full toolset). Slash commands should pick the narrowest type that does the job:

- **Exploration of an unfamiliar codebase** → `Explore`.
- **Planning a non-trivial implementation** → `Plan`.
- **Edits across files or running tools** → `general-purpose`.

### What this is not

- **Not a separate runtime.** No worker processes, no IPC, no job queue. Subagents are session-internal.
- **Not a way to skip the lifecycle gates.** A subagent's findings flow back to the master, which still records the right evidence before the run advances.
- **Not how the implementation phase works.** The "agent implements the change" step happens in the worktree, in the master session, with the master's full tool surface. Implementation can spawn its own subagents for parallelizable file work, but the per-stage worker model is explicitly out of scope.

## Boundaries

What Agent Workbench does:

- Track runs and their lifecycle state.
- Spawn isolated worktrees and feature branches.
- Persist all planning, decisions, validation, and audit artifacts.
- Generate handoff summaries from artifacts.

What Agent Workbench does **not** do:

- Open PRs (the user does this with `gh` or the GitHub UI).
- Run CI (the product repo's CI does this).
- Modify the product repo's files outside the worktree.
- Talk to GitHub or any remote API.
- Embed an AI agent. Agent Workbench is the *substrate* for agent work, not the agent.

## Workspace layout

```text
agent-workbench/
  README.md
  architecture.md
  lifecycle.md
  LOG.md
  agent-workbench.yaml

  schemas/
    transitions.yaml
    run-metadata.yaml
    events.jsonl

  runs/
    <run_id>/
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

  worktrees/
    <repo_name>/
      <worktree_name>/
        ... repo checkout for one branch ...
```

The source repo can live anywhere. Agent Workbench only stores its path in the run metadata.

## Core entities

### Run

A run is the unit of orchestration.

A run has:

- a `run_id`
- a current `status`
- one target repo path
- one branch name
- one worktree name
- one worktree path
- markdown artifacts
- an append-only event log

### Target repo

A target repo is a git repo path supplied by the user or created at a user-supplied path.

Agent Workbench does not maintain a source-of-truth repo registry.

Repo metadata belongs to the run:

```yaml
target:
  repo:
    mode: existing
    path: /Users/me/code/app
    name: app
    base_ref: HEAD
```

### Worktree

A worktree is the isolated checkout where implementation happens.

Worktree path format:

```text
<workbench_root>/worktrees/<repo_name>/<worktree_name>/
```

Example:

```text
agent-workbench/worktrees/app/add-login-form/
```

### Artifact

Artifacts are files inside `runs/<run_id>/`.

Important artifacts:

- `raw-idea.md`
- `brief.md`
- `plan.md`
- `preflight.md`
- `assumptions.md`
- `decisions.md`
- `implementation-summary.md`
- `diff-summary.md`
- `review.md`
- `qa/report.md`
- `audit.md`
- `handoff.md`

### Event

An event is one line in `events.jsonl`.

Events record transitions, assumptions, decisions, commands, artifacts, validation results, failures, bounces, and completion.

`events.jsonl` is the machine-readable audit source. `audit.md` is the human-readable rendering.

## Components

### CLI

The CLI is the user entrypoint.

Expected commands:

```text
new-run
shape
plan
start
validate
handoff
complete
bounce
abandon
```

The CLI should be explicit. Prefer `agent-workbench` over short aliases.

### Run store

The run store manages:

```text
runs/<run_id>/metadata.yaml
runs/<run_id>/events.jsonl
runs/<run_id>/*.md
```

It should append events rather than rewrite history.

### Transition engine

The transition engine validates:

- current state
- requested next state
- required evidence
- terminal-state rules
- wildcard abandon behavior

On success it:

- updates `metadata.yaml`
- appends `TransitionApplied` to `events.jsonl`
- updates `updated_at`

### Repo/worktree manager

The repo/worktree manager handles git operations.

For existing repos it verifies:

- `repo_path` exists
- `repo_path` is a git repo
- requested `base_ref` exists
- requested branch does not already conflict
- requested worktree path does not already conflict

For new repos it:

- creates the repo at the requested path
- initializes git
- creates a minimal initial commit
- uses monorepo layout by default when appropriate
- creates the branch and worktree

Implementation happens in the worktree only.

### Shaping agent

The shaping agent converts messy human input into `brief.md`.

Rules:

- may not read code
- may not inspect repo files
- may not ask questions
- must clarify goals, non-goals, examples, bad examples, constraints, and QA ideas

### Planning agent

The planning agent creates `plan.md`, `preflight.md`, `assumptions.md`, and `decisions.md`.

Rules:

- may inspect repo files
- may not ask questions
- must record assumptions before implementation
- must record decisions before implementation
- must choose the smallest safe implementation when ambiguous

### Building agent

The building agent implements inside the worktree.

Rules:

- follow `plan.md`
- keep scope bounded by `brief.md`
- record deviations
- update implementation and diff summaries

### Validation agent

The validation agent runs review and QA.

Rules:

- run self-review
- run applicable tests or scripts
- use Playwright or similar browser QA when useful
- record commands and results
- capture QA artifacts when available
- generate `audit.md` and `handoff.md`

## New repo behavior

A new repo is created at the user-provided repo path, not under a workbench-owned repo registry.

Example:

```text
repo_path: /Users/me/projects/shogi-go-app
worktree_path: /Users/me/agent-workbench/worktrees/shogi-go-app/bootstrap
```

The repo may be a monorepo by default:

```text
README.md
docs/
backend/
frontend/
```

The exact scaffold should come from the brief and plan, not from hard-coded assumptions.

## Existing repo behavior

An existing repo remains where it is.

Agent Workbench creates a branch and worktree from that repo.

Example:

```bash
git -C /Users/me/code/app worktree add \
  -b agent/add-login-form \
  /Users/me/agent-workbench/worktrees/app/add-login-form \
  HEAD
```

The original checkout should not be modified by the building agent.

## Audit model

The audit has two layers.

Machine-readable:

```text
runs/<run_id>/events.jsonl
```

Human-readable:

```text
runs/<run_id>/audit.md
```

The audit must show how the task reached completion or handoff, including:

- original request
- scope chosen
- repo path
- branch name
- worktree path
- assumptions
- decisions
- commands run
- implementation summary
- diff summary
- review result
- QA result
- transition timeline
- final status

## Failure model

Failures should be explicit events, not silent state changes.

Examples:

- `ErrorRecorded`
- `CommandRun` with non-zero exit
- `ValidationFailed`
- `TransitionRejected`
- `RunAbandoned`

A failed command does not automatically abandon a run. The agent may repair, retry, or hand off with known issues, but the audit must say what happened.

## Locks and concurrency

V1 should use a simple per-run lock:

```text
runs/<run_id>/.lock
```

Only one lifecycle command should mutate a run at a time.

V1 should also avoid creating two active worktrees with the same repo name and worktree name.

## Extensibility

Future versions may add:

- PR creation
- merge automation
- remote repo providers
- multi-repo run plans
- richer QA adapters
- scheduled cleanup of old worktrees

These should be added without changing the core rule:

```text
state changes require evidence, and the audit must explain the result.
```
