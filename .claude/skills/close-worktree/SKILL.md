---
name: close-worktree
description: Use when finishing work in an agent-workbench git worktree — first checks (via one origin fetch) whether the branch already landed (e.g. a merged PR); if not, rebases onto local main and fast-forwards; either way removes the worktree and deletes the branch. The clean counterpart to create-worktree.
---

# Close Worktree (agent-workbench)

## Overview

Finishes a `agent-workbench` worktree by getting its work onto **local `main`** and cleaning up. There are **two modes**, and Step 0 decides which one you're in — do NOT assume the branch still needs landing:

- **Mode A — LAND (branch not yet on main):** rebase → fast-forward local `main` → remove worktree → delete branch. This is the common case for a branch you just finished locally.
- **Mode B — CLEANUP-ONLY (branch already merged, typically via a remote PR):** the work is already on `main`, so there is **nothing to rebase or fast-forward** — just remove the worktree and delete the branch. Skipping Steps 2–3 here avoids the "do we even need to fast-forward?" confusion when a PR was merged out-of-band.

```
Step 0 (detect) ─┬─ already landed? ──► Mode B: Steps 4–5 (cleanup only)
                 └─ not landed?     ──► Mode A: Steps 2–5 (rebase, ff, cleanup)
```

**Core principle:** local `main` is the source of truth (same as [create-worktree]). The one allowed read of `origin` is a single `git fetch` in Step 0 to detect an out-of-band PR merge; never *push* and never move `origin` refs unless the user explicitly asks.

**Announce at start:** "Using the close-worktree skill: checking whether the branch already landed, then landing (if needed) and cleaning up."

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

### 1b. Detect the mode — has this branch already landed? (do this ONCE, up front)

The failure this prevents: a PR for `BRANCH` was merged on GitHub out-of-band, local `main` was already updated to include it, and you waste a turn trying to "fast-forward" work that is already on `main` (and hit a dirty-main guard for no reason). One cheap fetch settles it.

```bash
git -C "$REPO" fetch origin main        # the ONE allowed origin read; updates origin/main only
git -C "$REPO" log --oneline -1 origin/main   # look for "Merge pull request … <BRANCH>"
```

Then classify with an ancestry test — **is the branch tip already contained in `main` (local or origin)?**

```bash
git -C "$REPO" merge-base --is-ancestor "$BRANCH" main         # exit 0 => already on LOCAL main
git -C "$REPO" merge-base --is-ancestor "$BRANCH" origin/main  # exit 0 => already on ORIGIN main
```

Decision:

- **Branch tip is an ancestor of local `main`** → the work is fully landed locally. **Mode B: skip to Step 4 (cleanup only).** `-d` will delete the branch cleanly.
- **Branch tip is an ancestor of `origin/main` but NOT local `main`** → merged on the remote, local `main` is just behind. Fast-forward local `main` to `origin/main` (`git -C "$REPO" merge --ff-only origin/main` from a clean main checkout), then re-test the ancestry against local `main` → now Mode B, go to Step 4.
- **Branch has commits on neither** (e.g. a *rebased/amended* local tip that differs from what merged — the PR merged SHA `X`, but you later `--amend`ed to `X'`) → run `git -C "$REPO" diff --stat main "$BRANCH"`. If the only delta is work you still want, that's a genuine **unlanded change**: it did NOT land via the PR, so continue with **Mode A (Step 2)** to land it — or, if it should go through review, spin it into its own follow-up branch/PR and then treat the old branch as Mode B. If the diff is empty, it's Mode B.
- **Neither ancestor and there's real unmerged work** → **Mode A: continue to Step 2.**

Only Mode A runs Steps 2–3. Mode B jumps straight to Step 4.

### 2. Rebase the branch onto local main  *(Mode A only)*

Rebasing first guarantees a clean fast-forward (step 3) even if `main` moved while you worked.

```bash
git -C "$WT" rebase main
```

- Clean rebase → continue.
- **Conflicts** → resolve in the worktree (`git -C "$WT" ...`), `git -C "$WT" rebase --continue`. If it's hairy, `git -C "$WT" rebase --abort` and surface to the user — never force past a conflict.
- After rebasing, **re-run the tests** if the rebase pulled in non-trivial `main` changes that touch your files.

### 3. Fast-forward local main to the branch tip  *(Mode A only)*

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

**Safety gate before removing (both modes):** confirm the branch's work is on `main`.
- Mode A: the Step 3 `rev-parse main == rev-parse "$BRANCH"` equality is that proof.
- Mode B: `git -C "$REPO" merge-base --is-ancestor "$BRANCH" main` exiting 0 (from Step 1b) is that proof.

**If EnterWorktree-created** (session cwd is inside `<repo>/.claude/worktrees/...`):

Use the `ExitWorktree` tool with `action: "remove"`. It will report "N commits will be discarded" and refuse without `discard_changes: true` — this count is measured against the worktree's **original base ref** (often stale `origin/main`), NOT against `main`. Once the step-3 SHA check passes, those commits ARE on `main`, so `discard_changes: true` is safe (it deletes only the worktree dir + branch ref, never `main`). `ExitWorktree remove` deletes the branch for you.

**If create-worktree-skill-created** (under `~/GitHub/LOCAL_worktrees/...`), run from the MAIN repo, not inside the worktree:

```bash
git -C "$REPO" worktree remove "$WT"
git -C "$REPO" worktree prune
git -C "$REPO" branch -d "$BRANCH"     # -d is safe: refuses if not merged; post-ff it is merged
```

Use `-d` (safe) not `-D`; when the branch's work is on `main` (post-fast-forward in Mode A, or already-merged in Mode B), `-d` succeeds.

**If `-d` refuses ("not fully merged"):** the branch tip has a commit that is not on `main` — do NOT reflexively `-D`. This is exactly the Step 1b "neither ancestor" case, and it usually means a **rebased/amended local tip**: the PR merged SHA `X`, but you later `git commit --amend`ed to `X'`, so `X'` genuinely isn't on `main`. Diagnose:

```bash
git -C "$REPO" diff --stat main "$BRANCH"   # what does the branch have that main doesn't?
```

- Diff is empty → the content is on `main` under a different SHA; `-D` is safe.
- Diff is a change you still want → it did NOT land. Capture it first (new follow-up branch + PR, or re-land via Mode A), and only `-D` the stale branch **after** its unique content is preserved elsewhere. Never `-D` away unmerged work you haven't captured.

### 5. Verify + report

```bash
git -C "$REPO" branch --list "$BRANCH"   # empty => branch gone
git -C "$REPO" worktree list             # worktree gone
git -C "$REPO" log --oneline -3          # main carries the work
```

Report (pick the line matching the mode):
```
# Mode A (just landed it):
Landed on local main: <tip-sha> <subject>
Worktree removed, branch <branch> deleted. Working tree clean. Nothing pushed.

# Mode B (already merged, cleanup only):
Branch <branch> was already on main (merged via PR #<n>) — nothing to land.
Worktree removed, branch deleted. main unchanged.
```

## Learnings (avoid the churn)

- **Check whether the branch already landed BEFORE trying to land it (Step 1b).** In this repo, work often merges via a **remote PR** out-of-band, and local `main` gets updated to include it — so by the time you close the worktree there is nothing to rebase or fast-forward. One `git fetch origin main` + a `merge-base --is-ancestor` test tells you Mode A vs Mode B up front and skips the whole rebase/ff dance (and the pointless dirty-main stop) when it's already merged. Symptom of getting this wrong: you fast-forward, then notice `main` already had the commit, or you hit a dirty-main guard on a checkout full of *other* worktrees' WIP.
- **A `--amend`/rebase after a PR merged makes the local branch tip diverge from what landed.** If PR merged SHA `X` and you later amended to `X'`, `branch -d` correctly refuses (`X'` isn't on `main`) and `diff --stat main $BRANCH` shows the delta. Capture that delta (follow-up PR) before `-D`; it is the one legitimately-unlanded thing. Don't mistake it for "the close failed."
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
