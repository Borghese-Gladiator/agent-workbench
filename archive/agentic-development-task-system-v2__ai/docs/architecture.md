# Architecture

This doc explains *why* ai-workbench is shaped the way it is.

## Why orchestration is centralized

Most AI-coding setups scatter planning artifacts across the product repos themselves:
a `/specs` folder here, an `/ai/notes` folder there, decision docs buried in
random PR descriptions. Three problems follow:

1. **The product repo's history gets noisy.** Every spec revision is a commit in a
   tree where humans are trying to read code changes.
2. **Cross-repo context is impossible.** A feature that touches frontend + backend
   needs one shared planning home. Scattering it across two repos splits the memory.
3. **Source code accidentally inherits orchestration concerns.** Build pipelines,
   linters, and code search tools start to trip over `/ai` or `/runs` folders.

ai-workbench inverts the relationship: orchestration is its own repo, product repos
are downstream consumers. The product repos never know ai-workbench exists; they
just see well-formed feature branches arrive.

## Why worktrees are isolated

Every run gets a fresh worktree at `worktrees/<run_id>/`, checked out from the
product repo. Reasons:

- **Concurrency.** Multiple runs against the same product repo can coexist. Git
  worktrees are explicitly designed for this.
- **Clean rollback.** If a run is abandoned, removing the worktree and deleting the
  branch leaves zero residue in the product repo's working tree.
- **Reproducibility.** A worktree pinned to `<default_branch>` at run-creation time
  gives a stable starting point that won't drift while we plan.
- **Agent safety.** An agent confined to a worktree cannot accidentally trample
  the user's main checkout of the product repo.

We deliberately **do not** clone product repos. Worktrees share the same `.git`
directory as the source repo, so they're cheap and consistent with the user's
existing remotes, hooks, and config.

## Why "project" and "git repo" are separable

A registered entry in `config/repos.yaml` represents a **project**, not necessarily
a whole git repo. The git repo is the substrate (it holds the `.git`, the branch
namespace, the GitHub remote). The project is what an agent actually edits.

For the common case, project == git repo and the distinction doesn't matter. But
sometimes a project genuinely lives in a subdirectory of a larger git repo:
playground monorepos, sample apps, internal mini-projects under a parent shell.
Forcing every such project to get its own git repo just to use the workbench is
arbitrary — git already supports cutting a worktree from any commit of any repo.

The model is therefore:

- `repo_path` = git root. This is the only path `git -C` is ever called against.
  It owns the branches, the remotes, the worktree registry.
- `project_subpath` = optional relative path inside the git root. Empty when the
  project IS the git repo. Non-empty when the project lives in a subdirectory.
- `project_dir = repo_path / project_subpath` is the agent's working directory.

We do **not** use sparse-checkout or partial-tree worktrees to "hide" the
non-project parts of the monorepo. Reasons:

1. The agent might legitimately need to read sibling files (shared lint config,
   tsconfig, package.json at the root).
2. Sparse checkout's UX is brittle and surfaces git plumbing the user shouldn't
   need to think about.
3. The cost of a full checkout is bytes on disk, nothing else.

Branch noise (every `ai/<run_id>` lives in the parent repo regardless of which
subdir was touched) is the trade-off. Acceptable for personal / playground
monorepos; reconsider if the parent repo has strict branch policies.

## Why metadata.yaml is canonical

Every run directory has a `metadata.yaml` that records:

- `run_id`, `feature_slug`
- `repo_key`, `repo_path`, `project_subpath`, `github_repo`, `default_branch`
- `branch_name`, `worktree_path`
- `status`
- `created_at`, `updated_at`

(`repo_path` is the git root; `project_subpath` is empty when the project IS the
git repo. See [Why "project" and "git repo" are separable](#why-project-and-git-repo-are-separable).)

This file — not the directory name, not the branch name, not the worktree state —
is the source of truth. Reasons:

- **Directory names are lossy.** A path like
  `runs/2026-05-06-better-onboarding-001/` doesn't tell you which product repo
  the run targets, what status it's in, or which branch was created. Parsing it
  would force conventions to leak into code.
- **Filesystem state is mutable.** Worktrees can be removed, branches deleted, runs
  archived. We need a stable record of intent that survives those operations.
- **Tooling stays decoupled.** Any script — current or future — that needs to know
  "what is this run?" reads metadata.yaml. No regex on path components, ever.

The Python helper `lib/metadata.py` is the only thing that should write
`metadata.yaml`. Other scripts call into it.

## Why Python helpers, not pure bash

We use bash for orchestration glue (process control, git invocations, exit codes)
but Python for any structured parsing — specifically YAML reading/writing for
`config/repos.yaml` and `metadata.yaml`. Reasons:

- **YAML is fragile under bash.** `awk`/`sed` parsing breaks on quoting, comments,
  multi-line values. A 50-line Python helper is more robust than a 10-line awk
  pipeline.
- **No external deps.** We use Python's stdlib only (no `PyYAML`, no `yq`). The
  YAML we emit is a tiny flat subset, and our reader handles exactly that subset.
  This keeps `init-repo.sh` zero-install on any machine with Python 3.
- **Testable.** Helpers are importable; behavior can be exercised independently
  of the shell scripts.

## Why slash commands instead of shell scripts for the agent-bearing steps

Most workbench operations are deterministic plumbing — git worktree
create, `gh pr create`, status flips, file copies. Those live in
`scripts/` as bash, where they belong.

Three steps aren't deterministic: ingesting a Linear ticket needs Linear
MCP, running an adversarial review needs the Skill tool, stitching a PR
description needs an LLM over local artifacts. None of those are
available outside an active Claude Code session — MCP servers and
skills are session-scoped.

For a long time those three steps were shell scripts that did the
deterministic prefix (validate state, capture diffs) and then printed a
paragraph asking the user to switch into a fresh Claude session and
paste a prompt. That worked but turned a single workflow into three
context-switches per run.

The fix is to make those steps slash commands under
[`.claude/commands/`](../.claude/commands), since the user is already in
a Claude Code session when they run any other workbench script. Slash
commands inherit the session's MCP auth and can call the Skill tool
in-process. The deterministic prefix moves into a Bash block at the top
of the markdown; the LLM-bearing step lives in the body. Same code, no
context-switch.

This isn't a relaxation of "ai-workbench is the substrate for agent
work, not the agent" — the workbench still doesn't embed an agent. It
just publishes the slash commands an agent (in any Claude Code session)
can invoke against a workbench checkout.

## Subagent discipline

The workbench's "multi-agent" model is **not** a per-stage worker
process pool, a job queue, or a long-running daemon. It is a discipline
about *how slash commands compose their work inside a single Claude
Code session*.

Three rules:

### 1. The master session is the orchestrator and owns lifecycle state.

Only the master session reads and writes `runs/<run_id>/metadata.yaml`,
appends to `events.jsonl`, and calls `lib.transitions.transition_with_evidence`.
Lifecycle state is single-threaded by construction. Subagents never
mutate metadata directly — they return findings to the master, which
then decides whether to advance status.

### 2. Subagents handle parallelizable work via the Agent tool.

When a slash command needs to do `N` similar pieces of work that don't
depend on each other — exploring `N` candidate approaches, reviewing
`N` worktrees, drafting `N` summaries — it spawns `N` subagents in a
single tool-use turn so they run concurrently. The master collates the
results into one artifact. The canonical example is
[`/brainstorm`](../.claude/commands/brainstorm.md), which fans out 2–4
exploration subagents (one per candidate approach) and collates their
findings into `DR-NNN` entries in `decisions.md`. `/review-run` follows
the same shape when invoked with multiple reviewer skills.

### 3. Subagents are scoped via the narrowest Agent type that fits.

Claude Code's Agent tool exposes agent types with different tool
allowlists (Explore = read-only search; Plan = read-only with planning
tools; general-purpose = full toolset). Slash commands should pick the
narrowest type that does the job:

- **Exploration of an unfamiliar codebase** → `Explore`.
- **Planning a non-trivial implementation** → `Plan`.
- **Edits across files or running tools** → `general-purpose`.

A read-only fan-out (`/brainstorm`'s research subagents) uses `Explore`.
An adversarial review (`/review-run`) uses whichever review skill is
named.

### What this is not

- **Not a separate runtime.** No worker processes, no IPC, no job queue.
  Subagents are session-internal.
- **Not a way to skip the lifecycle gates.** A subagent's findings flow
  back to the master, which still calls `transition_with_evidence` with
  the right evidence shape before the run advances.
- **Not how the implementation phase works.** The "agent implements the
  change" step happens in the worktree, in the master session, with the
  master's full tool surface — that's the simplest path and matches the
  user's existing workflow. Implementation can certainly spawn its own
  subagents for parallelizable file work, but the per-stage worker model
  is explicitly out of scope.

The workbench's substrate role is unchanged: it provides the runs, the
worktrees, the artifacts, and the evidence-bearing state machine.
Subagent discipline is a pattern for how a session (any session) uses
the workbench, not a new layer in the workbench itself.

## Boundaries

What ai-workbench does:

- Maintain a registry of product repos.
- Create and track runs.
- Spawn isolated worktrees + feature branches.
- Persist all planning, decisions, and QA notes.
- Generate PR summaries from artifacts.

What ai-workbench does **not** do:

- Open PRs (the user does this with `gh` or the GitHub UI).
- Run CI (the product repo's CI does this).
- Modify the product repo's files outside the worktree.
- Talk to GitHub or any remote API.
- Embed an AI agent. ai-workbench is the *substrate* for agent work, not the agent.
