---
name: create-worktree
description: Use when creating a git worktree for agent-workbench — bases the new branch off LOCAL main (never origin/main) and routes the worktree to a sibling LOCAL_worktrees directory to keep the repo clean
---

# Worktree (agent-workbench)

## Overview

Creates a git worktree for the `agent-workbench` repo off **your local `main`**, in a sibling `LOCAL_worktrees` directory instead of inside the repo itself.

**Core principle:** Always base the new branch on the **local `main`** ref — never `origin/main`. Local `main` is the source of truth here; do not fetch or reset to origin before branching.

**Worktree location:** `~/GitHub/LOCAL_worktrees/agent-workbench/<dir-name>` — a sibling of the repo, so worktrees never clutter the active checkout.

**Announce at start:** "Using the worktree skill to create an isolated workspace off local main."

## When to Use

- User says "create a worktree" while working in `agent-workbench`
- Any workflow needs an isolated workspace for `agent-workbench`

## Creation Steps

### 1. Detect Repo and Confirm Local main

```bash
repo_root=$(git -C ~/GitHub/agent-workbench rev-parse --show-toplevel)
repo_name=$(basename "$repo_root")
```

Confirm this is `agent-workbench`. If not, stop — this skill only covers `agent-workbench`.

Verify local `main` exists (it is the base ref — do NOT use `origin/main`):

```bash
git -C "$repo_root" rev-parse --verify main
```

### 2. Create the Worktree off LOCAL main

**CRITICAL — branch name ≠ directory name.** Branch names often contain slashes (`timothyshee/fix-foo`). A slash is a path separator, so passing the raw branch name as the worktree path nests the worktree at an unexpected location ("branch exists, no worktree"). Sanitize `/`→`-` for the on-disk directory only; keep `$BRANCH_NAME` intact for the git ref.

**CRITICAL — base off LOCAL main.** The final argument to `git worktree add` is the start-point. Pass the bare ref `main` (local), NOT `origin/main`.

```bash
worktree_base=~/GitHub/LOCAL_worktrees/$repo_name
worktree_dir_name="${BRANCH_NAME//\//-}"
mkdir -p "$worktree_base"

# New branch, based on LOCAL main (note the trailing `main` start-point):
git -C "$repo_root" worktree add "$worktree_base/$worktree_dir_name" -b "$BRANCH_NAME" main
```

If the branch already exists (checkout, no `-b`):
```bash
git -C "$repo_root" worktree add "$worktree_base/$worktree_dir_name" "$BRANCH_NAME"
```

Use `$worktree_base/$worktree_dir_name` as the worktree path everywhere below — never `$worktree_base/$BRANCH_NAME`.

### 3. Verify and Report

```bash
git -C "$worktree_base/$worktree_dir_name" branch --show-current
git -C "$worktree_base/$worktree_dir_name" log --oneline -3
# Confirm the new branch points at the same commit as local main:
git -C "$repo_root" rev-parse main
git -C "$worktree_base/$worktree_dir_name" merge-base HEAD main
```

Report:
```
Worktree ready at ~/GitHub/LOCAL_worktrees/agent-workbench/<dir-name>
Branch: <branch>  (based on local main)
Ready to work.
```

## Working in the Worktree

- **Git state:** always `git -C <worktree-path> <command>` — never a bare `git` call. The Bash tool's cwd does not reliably follow `git worktree add`, so an unqualified git command can target the wrong checkout.
- **Do NOT call `EnterWorktree`** for worktrees created by this skill — it only accepts worktrees under the repo's `.claude/worktrees/`. Operate with explicit `git -C <path>` for the rest of the session.
- Before any commit/push, verify with `git -C <path> branch --show-current` and `git worktree list`.

## Cleanup

To land the work on local `main` and clean up in one pass (rebase → fast-forward →
remove worktree → delete branch), use the **close-worktree** skill. For a bare
teardown without landing:

```bash
# From the main repo, NOT inside the worktree:
git -C ~/GitHub/agent-workbench worktree remove ~/GitHub/LOCAL_worktrees/agent-workbench/<dir-name>
git -C ~/GitHub/agent-workbench worktree prune
```

List active worktrees:
```bash
git -C ~/GitHub/agent-workbench worktree list
```

## Common Mistakes

### Basing off origin/main instead of local main
- **Problem:** `git worktree add ... -b <branch> origin/main` branches from the remote, discarding local `main` commits that haven't been pushed.
- **Fix:** Pass the bare `main` start-point. Do not fetch/reset to origin before branching.

### Slash in branch name → nested worktree
- **Problem:** Raw branch name with `/` used as the path nests the worktree; looks like it silently failed.
- **Fix:** `worktree_dir_name="${BRANCH_NAME//\//-}"` for the directory; keep the slash in the `-b` branch name.

### Running git from the wrong directory
- **Problem:** Bare `git` targets the main repo instead of the worktree.
- **Fix:** Always `git -C <worktree-path>`; verify with `git worktree list`.
