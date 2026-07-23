---
name: close-worktree
description: Use when finishing work in an agent-workbench git worktree — rebases the branch onto local main, fast-forwards local main to include the work, then removes the worktree and deletes the branch. The clean counterpart to create-worktree.
---

# Close Worktree (agent-workbench)

## Overview

Lands the work from a finished `agent-workbench` worktree onto **local `main`** and cleans up, in one ordered pass:

1. **Rebase** the worktree branch onto local `main` (get into a good state, no divergence).
2. **Fast-forward** local `main` to the branch tip (linear history, no merge commit).
3. **Remove** the worktree.
4. **Delete** the branch.

**Core principle:** local `main` is the source of truth (same as [create-worktree]). Never push, never touch `origin`, unless the user explicitly asks.

**Announce at start:** "Using the close-worktree skill to rebase, fast-forward main, and clean up."

## When to Use

- User says "fast-forward main and delete the worktree", "land this and clean up", "finalize the worktree", or similar while working in `agent-workbench`.
- Work in a worktree is complete, committed, and validated (tests green) and should land on local `main`.

## Preconditions (check first, don't skip)

- **All work is committed.** `git -C <worktree> status --short` must be empty. Uncommitted changes are lost by cleanup — stop and commit (or ask) if the tree is dirty.
- **Tests are green.** This skill lands code on `main`; only run it once validation passes. If unsure, run the suite first (see [create-worktree] env notes below).
- **Know which worktree layout you have.** Two exist in this repo:
  - **`EnterWorktree`-created:** lives under `<repo>/.claude/worktrees/<name>`; session cwd is inside it; remove via the `ExitWorktree` tool.
  - **`create-worktree`-skill-created:** lives under `~/GitHub/LOCAL_worktrees/agent-workbench/<dir>`; operate with `git -C <path>`; remove via `git worktree remove`.

## Bash rules (this repo's Bash tool)

- **No compound commands.** `&&`, `||`, and `;` are all rejected. Issue each command as a separate Bash call. Pipes (`|`) for a single logical op are fine.
- **Always `git -C <path>`.** The Bash cwd does not reliably follow worktrees; a bare `git` can target the wrong checkout. Use `git -C ~/GitHub/agent-workbench` for main-repo ops and `git -C <worktree-path>` for branch ops.

## Steps

Let `REPO=~/GitHub/agent-workbench`, `WT=<worktree-path>`, `BRANCH=<branch-name>`.

### 1. Confirm committed + capture the branch tip

```bash
git -C "$WT" status --short          # must be empty
git -C "$WT" branch --show-current   # -> BRANCH
git -C "$WT" rev-parse HEAD          # remember this tip SHA
```

If `status` is non-empty: STOP. Commit or ask the user; do not proceed.

### 2. Rebase the branch onto local main

Rebasing first guarantees a clean fast-forward (step 3) even if `main` moved while you worked.

```bash
git -C "$WT" rebase main
```

- Clean rebase → continue.
- **Conflicts** → resolve in the worktree (`git -C "$WT" ...`), `git -C "$WT" rebase --continue`. If it's hairy, `git -C "$WT" rebase --abort` and surface to the user — never force past a conflict.
- After rebasing, **re-run the tests** if the rebase pulled in non-trivial `main` changes that touch your files.

### 3. Fast-forward local main to the branch tip

The main checkout is normally **on `main`**, so you cannot move the ref with `git branch -f`
(it refuses to move a checked-out branch). Use a `--ff-only` merge **from the main repo**:

```bash
git -C "$REPO" branch --show-current   # expect: main
git -C "$REPO" status --short          # expect: clean
git -C "$REPO" merge --ff-only "$BRANCH"
```

- `--ff-only` guarantees NO merge commit; it fails loudly if a fast-forward isn't possible (which, post-rebase, should never happen). If it fails, the rebase in step 2 didn't take — re-check, don't force.
- If the main checkout is dirty or on another branch, stop and tell the user rather than moving refs under uncommitted work.

**Verify main tip == branch tip before removing anything:**

```bash
git -C "$REPO" rev-parse main
git -C "$WT" rev-parse "$BRANCH"
```

These two SHAs MUST be identical. This is the safety gate: it proves the branch's work is preserved on `main`, so removal discards nothing.

### 4. Remove the worktree + delete the branch

**If EnterWorktree-created** (session cwd is inside `<repo>/.claude/worktrees/...`):

Use the `ExitWorktree` tool with `action: "remove"`. It will report "N commits will be discarded" and refuse without `discard_changes: true` — this count is measured against the worktree's **original base ref** (often stale `origin/main`), NOT against `main`. Once the step-3 SHA check passes, those commits ARE on `main`, so `discard_changes: true` is safe (it deletes only the worktree dir + branch ref, never `main`). `ExitWorktree remove` deletes the branch for you.

**If create-worktree-skill-created** (under `~/GitHub/LOCAL_worktrees/...`), run from the MAIN repo, not inside the worktree:

```bash
git -C "$REPO" worktree remove "$WT"
git -C "$REPO" worktree prune
git -C "$REPO" branch -d "$BRANCH"     # -d is safe: refuses if not merged; post-ff it is merged
```

Use `-d` (safe) not `-D`; after the fast-forward the branch is merged into `main`, so `-d` succeeds. If `-d` refuses, the fast-forward didn't happen — investigate, don't `-D`.

### 5. Verify + report

```bash
git -C "$REPO" branch --list "$BRANCH"   # empty => branch gone
git -C "$REPO" worktree list             # worktree gone
git -C "$REPO" log --oneline -3          # main carries the work
```

Report:
```
Landed on local main: <tip-sha> <subject>
Worktree removed, branch <branch> deleted. Working tree clean. Nothing pushed.
```

## Learnings (avoid the churn)

- **`EnterWorktree` bases off `origin/main`, which is often behind local `main` in this repo.** A worktree created that way is refactoring STALE code. Symptom: the file you edit is ~hundreds of lines behind the main-checkout copy, or a `dist/`-driven build fails on symbols that exist in source. If you didn't use [create-worktree], diff your target file against `main` EARLY (`git -C "$REPO" diff main -- <file>`); if it diverges, `git -C "$WT" reset --hard main` and redo on current code before you sink work into the stale version. (Prefer [create-worktree] to avoid this entirely.)
- **Worktrees have no `node_modules`.** A fresh worktree can't build/test until `pnpm install --frozen-lockfile` runs in it (fast — reuses the store). Package dists may also be stale; `pnpm run build` (root) builds all packages in dependency order. Cross-package type errors like "no exported member X" usually mean a stale dependency `dist`, not your code — rebuild before believing them.
- **The "N commits discarded" warning is measured against the worktree's base ref, not `main`.** After the step-3 SHA-equality check, it's noise — the commits are on `main`. That check is the real safety gate; do it every time and the discard is provably lossless.
- **Rebase → ff-only, in that order, gives linear history with zero merge commits and no force.** If `--ff-only` ever fails post-rebase, something is off (usually the rebase silently didn't apply) — stop, don't reach for `-f`/`-D`/`--no-ff`.
- **All main-ref moves happen from the main checkout via `git -C "$REPO"`.** You cannot `git branch -f main` while `main` is checked out; `merge --ff-only` from the main repo is the move.

## Common Mistakes

### Removing the worktree before verifying main has the work
- **Problem:** Trusting the "discarded N commits" prompt or removing before the SHA check → real data loss.
- **Fix:** Always assert `rev-parse main` == `rev-parse <branch>` first (step 3). Only then remove.

### Fast-forwarding with a dirty or wrong-branch main checkout
- **Problem:** Moving `main` while the main checkout has uncommitted changes or sits on another branch corrupts state.
- **Fix:** Confirm `git -C "$REPO" branch --show-current` is `main` and `status --short` is clean before the merge.

### Using `git branch -D` when `-d` refuses
- **Problem:** `-D` force-deletes an unmerged branch → loses commits not on `main`.
- **Fix:** `-d` only. A refusal means the work isn't on `main` yet — fix the fast-forward, don't force-delete.
