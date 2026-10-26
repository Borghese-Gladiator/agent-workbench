---
name: close-pr
description: Use when finishing an agent-workbench worktree by MERGING its open PR (not landing locally) — marks the draft ready, squash-merges the PR on GitHub, then reconciles the LOCAL side (fast-forwards local main to the squashed commit, safely stashing any unrelated uncommitted work in the main checkout) and removes the worktree + branch. The PR-merge counterpart to close-worktree; use it when the branch is delivered through a GitHub PR rather than a local fast-forward.
---

# Close PR (agent-workbench)

## Overview

Finishes a `agent-workbench` worktree whose work is delivered **through a GitHub PR**: it
**merges the PR online** and then makes the **local** side match — so that when you're done, both
`origin/main` and your local `main` carry the change and the worktree/branch are gone.

This is the counterpart to **close-worktree**. The difference is *where the landing happens*:

- **close-worktree** lands the branch onto local `main` yourself (rebase → `--ff-only`), no PR involved.
- **close-pr** (this skill) lands via a **GitHub PR merge** (squash by default), which creates a
  **new commit SHA on `main`** (`0f324f0`-style) that differs from your branch tip — then
  fast-forwards local `main` to that squashed commit and cleans up.

**Announce at start:** "Using the close-pr skill: merging the PR, then fast-forwarding local main and cleaning up the worktree."

## When to Use

- The worktree's work is committed, pushed, and has an **open PR**, and the user says "merge this PR",
  "close the PR and clean up", "land PR #N", "squash-merge and finalize", or similar.
- The delivery path is a PR (the normal agent-workbench flow), not a purely-local fast-forward.

If there is **no PR** (you just want to land a local branch onto local main), use **close-worktree** instead.

## Core principles

- **The PR is the source of truth for merging; local `main` is reconciled to match it afterward.**
  We merge on GitHub, then fast-forward local `main` to the merged commit. We never push local `main`.
- **Never move refs or discard work under uncommitted changes.** The main checkout in this repo often
  has unrelated WIP (e.g. an in-progress `docs/TODO.md` edit). Stash it, fast-forward, pop it back —
  never blow it away, never commit it on the user's behalf.
- **Squash by default.** agent-workbench branches are cut from local `main` and frequently carry a
  first commit that is shared, unpushed local-main history (e.g. a big `docs/TODO.md` rewrite). Squash
  collapses the branch to a single clean commit on `main`; if that shared commit is already on
  `origin/main` by merge time it simply drops out. Confirm the method with the user if unsure.

## Bash rules (this repo's Bash tool)

- **No compound commands.** `&&`, `||`, `;` are rejected — issue each as a separate Bash call. Pipes (`|`) for a single logical op are fine.
- **Always `git -C <path>`.** Bash cwd does not reliably follow worktrees. Use `git -C ~/GitHub/agent-workbench` for main-repo ops and `git -C <worktree-path>` for branch ops.
- **`gh` for all GitHub operations** (PR state, merge, ready). Model-run repo-aware git can use MCP; the merge itself is a `gh pr merge`.

## Preconditions (check first, don't skip)

- **All work is committed.** `git -C <worktree> status --short` must be empty. Uncommitted work in the
  worktree is lost by cleanup — stop and commit (or ask) if dirty.
- **Tests are green.** This lands code on `main` via merge; only run once validation passes.
- **Branch is pushed and a PR exists.** No PR ⇒ this is the wrong skill (use close-worktree).

## Steps

Let `REPO=~/GitHub/agent-workbench`, `WT=<worktree-path>`, `BRANCH=<branch-name>`, `PR=<pr-number>`.

### 1. Confirm the worktree is committed + capture the branch tip

```bash
git -C "$WT" status --short          # must be empty
git -C "$WT" branch --show-current   # -> BRANCH
git -C "$WT" rev-parse HEAD          # branch tip (will differ from the squash SHA later — expected)
```

If `status` is non-empty: STOP. Commit or ask; do not proceed.

### 2. Inspect the PR — state, mergeability, draft, method

```bash
gh pr view "$PR" --repo Borghese-Gladiator/agent-workbench \
  --json state,isDraft,mergeable,mergeStateStatus,baseRefName,headRefName,commits \
  --jq '{state, isDraft, mergeable, mergeState: .mergeStateStatus, base: .baseRefName, head: .headRefName, commits: [.commits[].oid]}'
```

Read it before doing anything:

- **`mergeable: MERGEABLE` + `mergeState: CLEAN`** ⇒ no rebase needed. GitHub already computed the
  merge against the real base and found it clean. **Do NOT rebase "just in case"** — it only churns SHAs.
- **`mergeState: BEHIND`** ⇒ base moved; update the branch (`gh pr update-branch "$PR"` or rebase in the
  worktree onto the base, then push) before merging.
- **`mergeState: DIRTY` / `mergeable: CONFLICTING`** ⇒ real conflicts. Resolve in the worktree, push,
  re-check. Never force past conflicts.
- **`isDraft: true`** ⇒ GitHub refuses to merge a draft with a bare
  `GraphQL: Pull Request is still a draft (mergePullRequest)` error. Mark it ready in Step 3 FIRST.
- Note the **base branch** (usually `main`) and that the **commit list** may include a shared first
  commit (unpushed local-main history) — that's normal for branches cut from local `main`, and squash
  makes it a non-issue.

### 3. Mark ready if draft  *(only if `isDraft: true`)*

```bash
gh pr ready "$PR" --repo Borghese-Gladiator/agent-workbench
```

This is the trap that wastes a turn: attempting the merge on a draft fails with "still a draft".
Marking ready up front avoids it.

### 4. Squash-merge the PR

Default to `--squash`. Give it a clean subject (the PR title works) and a body summarizing the change
(a compressed PR body). Do NOT `--delete-branch` via gh here — cleanup in Step 6 removes the *local*
branch + worktree; deleting the remote branch is the user's call (mention it if they want it gone).

```bash
gh pr merge "$PR" --repo Borghese-Gladiator/agent-workbench --squash \
  --subject "<PR title>" \
  --body "<one-paragraph summary of the change + proof/tests>"
```

`gh pr merge` can complete with **no stdout** on success — do not assume it failed. **Verify:**

```bash
gh pr view "$PR" --repo Borghese-Gladiator/agent-workbench \
  --json state,mergedAt,mergeCommit --jq '{state, mergedAt, mergeCommit: .mergeCommit.oid}'
```

`state: MERGED` + a `mergeCommit` OID ⇒ merged. Remember that OID — it's the commit local `main`
will fast-forward to. (Choose `--merge` or `--rebase` instead only if the user asked; squash is the default.)

### 5. Reconcile LOCAL main to the merged commit

This is the part close-worktree doesn't do. The squash created a new commit on `origin/main`; get
local `main` there too.

```bash
git -C "$REPO" fetch origin main                 # updates origin/main to include the squash commit
git -C "$REPO" branch --show-current             # expect: main
git -C "$REPO" status --short                    # inspect BEFORE moving anything
```

**Guard — uncommitted work in the main checkout.** If `status --short` shows a **modified tracked
file** (very common here: an in-progress `docs/TODO.md`), a `--ff-only` will abort with
`Your local changes … would be overwritten by merge`. Do NOT commit or discard it — **stash just that
work, fast-forward, then pop it back**:

```bash
# Only if there is modified tracked content blocking the ff. Untracked files (??) don't block it.
git -C "$REPO" stash push -m "WIP (pre-close-pr)" -- <the-blocking-path(s)>
git -C "$REPO" merge --ff-only origin/main
git -C "$REPO" stash pop
```

- `stash pop` will `Auto-merging <file>` and usually succeeds cleanly (the WIP edits reapply on top of
  the updated file). If it **conflicts**, resolve the conflict in favor of preserving the user's WIP,
  leave the file modified (do not commit), and tell the user their WIP is restored with a conflict they
  should review. Never drop the stash unresolved.

If the main checkout is clean, just fast-forward:

```bash
git -C "$REPO" merge --ff-only origin/main
```

**Verify local main advanced:**

```bash
git -C "$REPO" log --oneline -1 main             # tip == the squash mergeCommit OID from Step 4
```

### 6. Remove the worktree + delete the branch

**Safety gate:** the branch's content is on `main` (it merged via the PR). Confirm it's not a
divergent local tip carrying unlanded work — a content diff of the changed areas against `main`
should be empty:

```bash
git -C "$REPO" diff --stat main "$BRANCH"        # empty => fully landed; safe to remove
```

Then remove. **create-worktree-skill worktrees** live under `~/GitHub/LOCAL_worktrees/...`; operate
from the MAIN repo:

```bash
git -C "$REPO" worktree remove "$WT"
git -C "$REPO" worktree prune
git -C "$REPO" branch -d "$BRANCH"
```

- Use `-d` (safe), not `-D`. Because the branch merged via **squash**, its tip SHA differs from the
  commit on `main`, so `-d` prints a warning like *"has been merged to
  `refs/remotes/origin/<branch>`, but not yet merged to HEAD"* and **still deletes it** — that's the
  expected, safe outcome (the remote-tracking ref proves it merged).
- **If `-d` refuses outright** ("not fully merged") AND the Step 6 `diff --stat main "$BRANCH"` is
  **non-empty**, the branch has real unlanded work (e.g. a post-merge `--amend`). Do NOT `-D` it away —
  capture that delta (follow-up PR) first, exactly as in close-worktree. Empty diff ⇒ `-D` is safe.

**EnterWorktree-created worktrees** (under `<repo>/.claude/worktrees/...`) instead use the
`ExitWorktree` tool with `action: "remove"`, `discard_changes: true` (safe once Step 5/6 prove the
work is on `main`) — see close-worktree for that path.

### 7. Verify + report

```bash
git -C "$REPO" branch --list "$BRANCH"           # empty => branch gone
git -C "$REPO" worktree list                     # target worktree gone; others untouched
git -C "$REPO" log --oneline -3 main             # main carries the squash commit
```

Report:
```
Merged PR #<PR> (squash) → main as <mergeCommit-sha>.
Local main fast-forwarded to <mergeCommit-sha>[; your WIP <path> was stashed across the ff and restored].
Worktree removed, branch <branch> deleted. Nothing pushed beyond the PR merge.
```

Mention leftover working-tree state you deliberately did not touch (restored WIP, untracked files),
and — if relevant — that the **remote** branch still exists (offer to delete it if the user wants).

## Learnings (avoid the churn we hit building this)

- **A draft PR cannot be merged.** `gh pr merge` on a draft fails with
  `GraphQL: Pull Request is still a draft (mergePullRequest)`. Run `gh pr ready` first — check
  `isDraft` in Step 2 so you never eat that error.
- **`gh pr merge` can succeed silently (no stdout).** Don't infer failure from empty output — verify
  with `gh pr view … --json state,mergeCommit`.
- **Squash ⇒ branch tip ≠ main commit.** After a squash merge, `merge-base --is-ancestor "$BRANCH"
  main` returns *false* even though the work landed, and `branch -d` warns "not yet merged to HEAD".
  This is normal. The real proof of landing is `diff --stat main "$BRANCH"` being empty (content is
  on `main` under a different SHA). Don't reach for `-D` on the warning alone.
- **The main checkout usually has unrelated WIP.** In this repo `docs/TODO.md` is frequently
  mid-edit. A `--ff-only` aborts on modified tracked files (untracked `??` files do NOT block it).
  Stash *only the blocking path* (`stash push -- <path>`), ff, then `stash pop` — never commit or
  discard the user's in-progress work to unblock yourself.
- **Don't rebase a CLEAN/MERGEABLE PR "to be safe".** GitHub already computed the merge against the
  base; if it says CLEAN there is nothing to reconcile. Rebasing only churns SHAs and can invalidate
  approvals. Only update-branch/rebase when `mergeState` is `BEHIND`/`DIRTY`.
- **We never push local `main`.** Local `main` is fast-forwarded to `origin/main` (which the PR merge
  advanced). Pushing `main` is out of scope unless the user explicitly asks.

## Common Mistakes

### Trying to merge before marking the draft ready
- **Problem:** `gh pr merge` errors "still a draft"; a wasted turn.
- **Fix:** Check `isDraft` in Step 2; `gh pr ready` in Step 3 before merging.

### Fast-forwarding local main over uncommitted work
- **Problem:** `--ff-only` aborts (or, if forced, would clobber) an in-progress `docs/TODO.md` edit.
- **Fix:** Stash the specific blocking path, ff, pop. Preserve the user's WIP; never commit it for them.

### Force-deleting the branch on the squash "not merged to HEAD" warning
- **Problem:** `-D` on a branch you *think* didn't merge can drop genuinely-unlanded commits.
- **Fix:** `-d` first. If it refuses, check `diff --stat main "$BRANCH"` — only `-D` when that diff is
  empty (content is on main under the squash SHA). Otherwise capture the delta first.

### Assuming the merge failed because gh printed nothing
- **Problem:** Silent success looks like a no-op; you re-run and confuse yourself.
- **Fix:** Always verify with `gh pr view … --json state,mergeCommit`.
