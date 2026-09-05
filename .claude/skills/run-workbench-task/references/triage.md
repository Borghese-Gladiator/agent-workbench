# Triage a failed, blocked, or stalled task

Load this when a task fails, blocks, stalls, a gate loops, or `up` times out.

A hard failure is terminal in Temporal: **the workflow cannot be resumed — you
create a fresh task.** The repo stays trusted, so you skip the registration.
Diagnose FIRST. A blind re-run repeats the failure and wastes live tokens.

The real error is NOT in `task show`. Resolve
`DATA_DIR="${AWB_DATA_DIR:-$HOME/.agentic-workbench}"` first — and re-root it at
the isolated stack's data dir when the route said `stack=isolated`. Then look
here, in order.

## 0. When `up` times out

"Waiting for the daemon to become healthy… timed out" almost always means the
daemon crashed on import. **Do not loop `up` blindly. Read the log first:**

```
tail -40 "$DATA_DIR/runtime/logs/daemon.log"
```

Two common causes on a clean checkout, both build-state and not config:

- `ERR_MODULE_NOT_FOUND: Cannot find package '@awb/…'` — a workspace symlink was
  never materialized. `pnpm install` reports "up to date" and does NOT fix it.
  Run `pnpm install --force`.
- `SyntaxError: … does not provide an export named '…'` — a package `dist/` is
  stale. The daemon runs through `tsx` but imports other packages from their
  built `dist/`. Run `pnpm build`. The `apps/daemon` test-file TS error is
  harmless; the package dists build before it.

Then `down` the half-started processes and `up` again.

## 1. Worker log — the actual exception and stack

```
grep -n "Activity failed\|Error:\|returned 500" "$DATA_DIR/runtime/logs/worker.log" | tail -30
```

## 2. Semantic events — the agent's turn-by-turn stream

```
sqlite3 "$DATA_DIR/database/workbench.sqlite" \
  "SELECT sequence, occurred_at, phase, producer, type, substr(summary,1,70)
   FROM semantic_events WHERE run_id='<taskId>-run' ORDER BY sequence;"
```

## 3. The worktree — the code may be intact

Do NOT report "0 changes" from a database count alone. The agent commits its
work, so `status` can be clean while the branch is full.

```
git -C "$DATA_DIR/worktrees/<repoId>/<taskId>" status --short
git -C "$DATA_DIR/worktrees/<repoId>/<taskId>" log --oneline
git -C "$DATA_DIR/worktrees/<repoId>/<taskId>" diff <baseSha> HEAD
```

## 4. SQLite ground truth

Read the database directly when the CLI is down (a blank `task show`) or when you
need the exact failing predicate. Useful tables: `phase_attempts` (per-phase
attempts and outcomes), `program_designs`, `repository_commands` (is a `start`
command present?), `acceptance_claims` (does the contract require QA or
behavioral evidence?), and `semantic_events`.

## Known failure modes

- **`FOREIGN KEY constraint failed` at the plan phase** — a run-state durability
  bug, fixed 2026-07-24. If it recurs, suspect
  `packages/database/.../run-lifecycle.ts` plus a stale `@awb/database` dist;
  rebuild it.
- **`API Error: Connection closed mid-response`** — a transport drop from the
  agent SDK on long turns. Retries currently **cold-restart** with no resume, so
  each retry re-explores from scratch and can drift into the wrong repo. A run
  that spends many minutes repeating "I'll start by exploring the repository
  structure" in `semantic_events` is stuck in this loop. Kill it rather than let
  it burn tokens.

Distinguish an **agent or transport failure** (a re-run may help) from a
**workbench code bug** (fix it first) before you re-drive.

## Recover and land when the pipeline is stuck but the code is done

A run can block late — at `exercise` or QA — with the implementation already
complete and past `implement` and `verify`. The deliverable then lives in the
worktree branch even though the task will never reach `release`. Do not throw it
away to chase the gate.

**With a remote — open the draft PR straight from the branch:**

```
pnpm --filter @awb/cli cli -- task deliver-worktree
```

This opens a DRAFT PR from the task's committed worktree branch. Verification is
NOT re-run, so review the diff before merge.

**Without a remote, or when you need the code in the target checkout:**

1. **Confirm the code is real and works** before you touch anything. Inspect the
   branch, and for an app, boot it from the worktree and hit an endpoint. A
   verified worktree is the deliverable.
2. **Recover BEFORE you cancel.** `task cancel` may garbage-collect the worktree.
   A run that blocked before implementing leaves nothing, and even a completed
   one is not guaranteed to persist. Copy the code out first.
3. **Land it.** Copy only tracked files, excluding `.venv` and build cruft:
   `git -C <worktree> archive HEAD | tar -x -C "$TARGET"`. Then commit in the
   target repo, and verify a clean-install boot there so a new developer can
   reproduce it.
4. For a no-remote run this is the right ending. There is no PR to sign off, so
   the merged-PR gate never applies and the landed local commit IS the delivery.
