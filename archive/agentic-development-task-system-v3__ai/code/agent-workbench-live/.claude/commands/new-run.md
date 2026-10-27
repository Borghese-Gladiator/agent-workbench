---
description: Create a new Agent Workbench run from a repo path and an idea. Worktree slug is derived automatically. Does NOT create a worktree — that happens later in /start.
---

# /new-run

Creates a run record in state `draft`. **No worktree is created here.** The `git worktree add` happens later in `/start`, after `/draft`, `/shape`, and `/plan`.

## Required input from the user

Exactly two things:

1. **Repo path** — absolute path to an existing git repo (must contain the configured `base_ref`).
2. **An idea** — either inline text *or* a file path.

That's it. Do not ask the user for anything else.

## What you (the agent) do

### 1. Validate the repo path

- The path must exist and be a git repo.
- If invalid, stop and tell the user. Do not invoke the CLI.

### 2. Resolve the idea

- If the user gave a **file path** → use it directly as `--idea-file`.
- If the user gave **inline text** → pipe it to the CLI via stdin (see invocation below).
- If neither is present → ask **once**: "Paste the idea, or give me a path to the idea file." Then stop until they answer.

### 3. Derive the worktree slug

You **always** derive `--worktree-name`. Never ask the user for it.

- Take the first Markdown heading (`# Title`) from the idea text. If there's no heading, use the first non-empty line.
- Slugify it: lowercase, ASCII only, non-alphanumeric → single `-`, strip leading/trailing `-`, cap at 40 chars.
- The CLI re-slugifies via `lib/run_ids.py:slugify`, so your slug just needs to be reasonable.
- If the idea is empty or yields an empty slug, stop and tell the user.

### 4. Invoke the CLI

**File form** (idea was a path):

```bash
agent-workbench new-run \
  --repo-path <repo-path> \
  --worktree-name <derived-slug> \
  --idea-file <idea-file>
```

**Stdin form** (idea was inline text):

```bash
echo "<idea text>" | agent-workbench new-run \
  --repo-path <repo-path> \
  --worktree-name <derived-slug>
```

Do not pass `--scope-kind`, `--base-ref`, or `--repo-name`. Let CLI defaults apply.

Note: `repo_name` defaults to the slugified basename of the **git toplevel** (resolved via `git rev-parse --show-toplevel`), not the path you typed. So `/new-run` invoked from `~/code/monorepo/services/api` and `/new-run` invoked from `~/code/monorepo` land worktrees under the same second-level dir under `paths.worktrees_dir`. Pass `--repo-name` only if you genuinely want a second namespace for the same repo.

### 5. Report back

- Print the `run_id` the CLI returned.
- State explicitly: **"No worktree has been created yet. The worktree is created by `/start`."**
- Suggest the next step: `/draft <run_id>`.

## What you never do

- Never ask the user for `--worktree-name`. Derive it.
- Never read code in the target repo at this step. `/new-run` is code-blind.
- Never edit `metadata.yaml` directly.
- Never invoke `/start` from `/new-run` directly — `/start` is auto-chained from `/plan`, not from `/new-run`. The chain is `/new-run -> /draft -> /shape -> /plan -> /start`.

## Examples

**Inline idea:**

> User: `/new-run /Users/me/code/repo` — idea: Build a multiplayer poker game with WebSocket sync.

Agent derives slug `multiplayer-poker`, runs the stdin form, prints the `run_id`, says "no worktree yet; next: `/draft <run_id>`".

**File-based idea:**

> User: `/new-run /Users/me/code/repo ./poker-idea.md`

Agent reads the heading from `poker-idea.md`, derives slug, runs the file form, prints the `run_id`.

## Next step

Auto-chain: immediately invoke `/draft <run_id>` unless one of the stop conditions below is true. The agent only stops at the single human gate (`human_review`), not between autonomous stages. `ready` is a transient state the agent passes through by auto-chaining `/plan -> /start`. Clarifying questions, if any, are asked inside `/draft` — not here.

### Stop conditions (do NOT auto-chain)

Stop and tell the user the `run_id` and recommended next command if any of these is true:

- The CLI returned a warning or non-zero status.
- The user explicitly told you to stop after `/new-run` ("just create the run", "stop after new-run", etc.).

## Reference

- CLI implementation: `agent-workbench-live/lib/cli/cmd_new_run.py`
- Slug rules: `agent-workbench-live/lib/run_ids.py`
- Lifecycle contract: `docs/lifecycle.md` § `draft`
