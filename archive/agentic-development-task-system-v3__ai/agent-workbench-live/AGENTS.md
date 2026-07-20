# AGENTS.md

You are an AI agent (Claude Code, Codex, Cursor, anything similar) that has opened the Agent Workbench. This file tells you how to operate here.

If something below is unclear, read `../architecture.md` and `../docs/lifecycle.md` for the full design. This file is the short version.

---

## What this is

Agent Workbench is a local run orchestrator. One run = one fuzzy idea turned into one isolated git worktree, one feature branch, one set of artifacts, and one audit trail. It does not embed an agent. **You** are the agent. The workbench is the substrate.

## The lifecycle (memorize this)

```text
draft -> shaping -> planning -> ready -> building -> validating -> human_review -> done
```

Any non-terminal state can also go to `abandoned`. `human_review` can bounce back to `building`. Read `../docs/lifecycle.md` for the per-stage contract (inputs, produces, exit evidence) and the agent-may-ask / may-read-code matrix.

## Two hard rules

1. **Only `draft` may ask the human clarifying questions.** Every other state proceeds by recording an assumption (`assumptions.md`), a decision (`decisions.md`), or stopping with evidence.
2. **Only `lib/transitions.transition(...)` writes `status`.** Never edit `runs/<run_id>/metadata.yaml`'s `status` field by hand. Never append to `events.jsonl` directly. Use the CLI.

## How to drive the workbench

When you see a `STOP.` banner in CLI stdout for `human_review` or a terminal state (`done`, `abandoned`), your session ends — those are the states the agent does not drive. The `ready` banner is informational only: `ready` is a transient state that the agent passes through by auto-chaining `/plan -> /start`, so do not stop on it. For the agent-stopping banners, do not invoke the listed next commands; those are the human's call.

Use the CLI (`agent-workbench <subcommand>`) or the matching slash command in Claude Code. Slash commands wrap the CLI for the LLM-bearing steps. The full command → state map lives in `../docs/lifecycle.md` § "Command-to-state map".

LLM-bearing slash commands: `/shape`, `/plan`, `/validate`, `/followups`. Thin wrappers (just call the CLI): `/new-run`, `/start`, `/handoff`, `/complete`, `/bounce`, `/abandon`, `/runs`, `/run-show`.

## Source of truth

- `runs/<run_id>/metadata.yaml` — current state, pointers to artifacts. Written only by the metadata + transitions modules.
- `runs/<run_id>/events.jsonl` — append-only history. Written only by the events module.
- `runs/<run_id>/*.md` — the artifacts you fill in (brief, plan, assumptions, decisions, build, review, qa, etc.).
- `runs/<run_id>/audit.md` — human-readable timeline, rendered during validation.

Directory names, branch names, and worktree paths are **not** sources of truth. If they disagree with `metadata.yaml`, `metadata.yaml` wins.

The run dir's **physical location** depends on the run's lifecycle stage and whether it's self-modifying (the workbench is inside the target repo):

- Self-modifying runs live inside their worktree (`<worktree>/agentic-development-task-system-v3__ai/agent-workbench-live/runs/<run_id>/`) from `new-run` until `complete` or `abandon`. After the terminal merge, master picks up the run dir at `<workbench>/runs/<run_id>/` (`complete`) or `<workbench>/runs/abandoned/<run_id>/` (`abandon`).
- Non-self-modifying runs (unrelated product repo) keep the run dir at `<workbench>/runs/<run_id>/` the whole way through; the worktree is the *product* worktree and never holds the run dir.

The `target.worktree.path` field is the canonical pointer for self-modifying runs. `lib/runs.py:find_run` resolves any run id to its current physical location across master + every workbench worktree.

## When you get stuck

- **Ambiguity during `shaping`/`planning`** → record an assumption in `assumptions.md` (or plan.md's "Decisions & assumptions"), continue with the safest small impl. Don't ask the human.
- **Command failed during `building`** → record it in `build.md`. Repair; don't silently retry. If you can't proceed, hand off with known issues.
- **State seems wrong** → `agent-workbench show <run_id>` and `agent-workbench events <run_id>`. Never patch `metadata.yaml`.
- **Transition rejected** → read the `TransitionRejected` event's `reason` field — it lists the missing evidence.

## Session discipline

Claude Code's conversation prefix grows monotonically inside a session. Every turn re-reads the full prefix — `cache_read_input_tokens` accumulates as `(prefix size) × (turn count)`. On a long single session, this is the dominant cost: the pass-1 dogfood run paid 121.8M tokens of `cache_read` (98.7% of total) across 621 turns in one session. Pass-2 measurement lives in `lib/metrics/buckets.py` (`cache_read buckets`); the rules below are the structural fix.

When the agent sees a `STOP.` banner from the CLI (e.g. after `/followups`), the run is human-owned. Stop the session.

- **Always start a new Claude Code session at the `/validate` boundary** when the building session has more than 100 turns. The handoff is the `run_id` + worktree path — nothing else needs to carry over, because `validate --init` writes `stages/5_validating/validate-context.md` + `blast-radius.txt` for you. (Threshold is configurable via `session_staleness_threshold_turns` in `agent-workbench.yaml`; `validate --init` prints a copy-pasteable handoff block when the threshold is crossed.)
- **Always start a new session between independent runs.** A new `/new-run` for an unrelated task = exit Claude Code and relaunch first. Cross-run prefix has zero amortization value.
- **Stay in the same session for `/shape` → `/plan` → `/build`.** These share useful context (the brief informs the plan; the plan informs the build); the cache amortizes well here.
- **Read the curated stage-entry context first.** Two stages now produce one: `/start` writes `build-context.md` at `ready → building`; `/validate --init` writes `validate-context.md` at `building → validating`. Each lifts only what the next stage needs from prior artifacts. Read the curated file once; reach for `brief.md` / `plan.md` / `build.md` only when its sections are insufficient. TODO §1 will extend this contract to the remaining LLM-bearing stages (`shape`, `plan`, `followups`).
- **Restart when you see Claude Code's auto-compact notice.** The prefix is already heavy. Restart with the fresh-session handoff rather than letting auto-compaction run mid-task.

### Why

The cache layer doesn't deduplicate across sessions, and Claude Code's auto-compact isn't aligned to the lifecycle boundary. So discipline is the only lever: cut the session at the point where the next stage genuinely doesn't need the prior conversation (the validate boundary qualifies — the validator needs the diff and the right files, not the build session's history). The handoff block printed by `validate --init` when `largest_session_turns > threshold` is the explicit nudge.

## Subagent discipline

When you fan out work via Claude Code's Agent tool:

- The master session owns lifecycle state. Subagents return findings; the master decides whether to advance status.
- Pick the narrowest agent type. `Explore` for read-only search. `Plan` for planning. `general-purpose` only when edits or tool use are needed.
- Subagents are session-internal. They never write `metadata.yaml` or `events.jsonl`.
- **Subagent-first read strategy for `/build` and `/validate`.** When a stage needs to read more than 3 files for *exploration* (not editing), route through an `Explore` subagent. File reads in the master session stick in the prefix forever; subagent reads do not — the subagent returns a summary; the master keeps a tiny footprint. Example: "find every call site of `record_run_metrics` in `agent-workbench-live/`" → spawn `Explore` rather than running four `grep`/`Read` calls in-session.

### Tool-output budget

Soft per-call budget for Bash tools. Not enforced; pattern guidance to keep prefix growth bounded:

- `Read` outputs over ~2k tokens → scope with `head -n 100`, `tail -n 100`, or `grep` before reading the whole file.
- `git log` → cap with `-n 20` unless the question demands full history.
- `git diff` → start with `--stat`; only run the full diff if needed.
- `find` → scope by `-name` / `-path`; avoid full-tree walks (`find /` is blocked anyway).

## Context library

Conventions, safety defaults, and per-language quartets live under `context/`. Agents lazy-import individual files via `@context/path/to/file.md` on demand — pull in the leaf you need at the moment you need it.

Start at `@context/README.md` — it indexes every file with one-line descriptions and import paths. Do not enumerate the library here; the index is the single source of truth and stays in sync as files are added or removed.

Adding or editing a leaf? Read `@context/AUTHORING.md` first.

## Where to read more

- `../architecture.md` — why it's shaped this way.
- `../docs/lifecycle.md` — every stage's contract (inputs, produces, exit evidence).
- `../docs/LOG.md` — chronological log of project decisions.
- `schemas/transitions.yaml`, `schemas/run-metadata.yaml`, `schemas/events.jsonl` — the formal contracts the CLI enforces.

## Regeneration

This file should be updated when:

- A CLI command is added, renamed, or removed.
- The lifecycle changes (new state, dropped state, new transition).
- Either hard rule above changes.
