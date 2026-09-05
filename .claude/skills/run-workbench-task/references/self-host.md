# Self-hosting: change agent-workbench with agent-workbench

Load this when the route says `self-host=yes` — the target repo IS a workbench
checkout.

Self-hosting splits one repo into two roles:

- **Controller** — the stable checkout and runtime that runs the workbench.
- **Target** — an isolated worktree that holds the code being changed.

**Never use one checkout as both controller and target during a live task.** The
route already set `stack=isolated`; `boot.md` owns that mechanism. This reference
owns the controller/target discipline and the verification that follows.

The flow is a delegate-then-verify loop, not a straight line. The implementation
is delegated to the workbench. Its result is verified against the plan and the
real diff, never against the task's own success message. A defect routes back
into a bounded repair loop before anything is committed.

Read `AGENTS.md` before you plan. It is authoritative for architecture, layout,
coding rules, and prohibited patterns. For changes under the Temporal worker,
also read `workers/temporal-worker/src/activities/AGENTS.md`.

## 1. Write the plan

Create `plan.md` in the target unit of work before any non-trivial edit:

```markdown
# Plan

## Brief
What is wrong or changing, and the intended behavior.

## Changes
- `path/to/file.ts` — specific intended edit

## Verification
- Unit: focused tests to add or change
- Manual: concrete command or behavior that proves the change
```

Keep the plan scoped to the smallest correct change. If the implementation spans
more than a few files, explain why. Do not expand scope to clean up nearby code.

Planning is not completion. Unless the user asked for plan-only work, continue
through implementation and verification in the same session.

## 2. Create the target worktree

Invoke `create-worktree`. Capture the resulting path and treat it as `TARGET`.
From this point:

- Run target commands with an explicit `git -C "$TARGET"` or `pnpm -C "$TARGET"`.
- Make all implementation edits inside `TARGET`.
- Do not modify the controller checkout as part of the feature.
- Use one worktree per independent unit of work.

Do not infer success from daemon or database state. The target worktree and its
git diff are authoritative for whether the source changed.

## 3. Delegate the implementation

Prefer a workbench task over editing `TARGET` yourself. The controller runtime
must come from a stable checkout or a pinned build that the task cannot edit.

Give the task:

- the user's requested behavior;
- the absolute `TARGET` path;
- the requirements from `plan.md`;
- the instruction to make the smallest correct change;
- the requirement to add focused tests;
- the requirement not to land, push, or delete the worktree.

**Do not run `awb up --dev` from a checkout that the task can edit.** A source
save hot-reloads the controller while it orchestrates itself. Build once, then
run pinned:

```
pnpm -C "$TARGET" build
awb up            # pinned by default; src/ edits do NOT hot-reload the runtime
```

## 4. Inspect the result independently

Do not accept the task's success message as proof. None of these prove success
on their own: a task reporting completion, daemon state, database row counts,
grep or string-match QA, or a clean controller checkout. The target diff plus
observed verification are the source of truth.

1. Inspect `git -C "$TARGET" status`.
2. Inspect the complete target diff.
3. Compare the diff against `plan.md`.
4. Look for unrelated edits, missing tests, architecture violations, and
   unnecessary abstraction.
5. Confirm the implementation addresses the requested behavior.

Repository invariants to check:

- Keep TypeScript strict. Do not introduce `any`.
- Validate process and persistence boundaries with Zod.
- Keep I/O out of `@awb/workflow`.
- Put Temporal I/O in `workers/temporal-worker/src/activities/`.
- Route writes through the daemon.
- Do not let agents decide phase completion.
- Prefer self-explanatory code over comments.

If the diff is empty, incomplete, incorrect, or materially outside the plan, do
not land it. Go to the repair loop.

## 5. Repair until the target is correct

Prefer another focused task against the same `TARGET`. Give the repair task the
observed failure, the relevant diff or test output, the expected behavior, and an
instruction to correct only the defect.

Edit the source directly only when one of these holds:

- the workbench cannot execute the required repair;
- repeated delegated attempts fail for the same reason;
- the change is trivial enough that delegation adds no useful verification.

State any direct editing explicitly when you report.

Do not retry endlessly. If the same substantive failure survives two focused
repair attempts, stop delegating, diagnose it directly, and either fix it or
report the blocker accurately. Each pass returns to step 4. The loop exits only
when the diff is correct and matches the plan.

## 6. Behavioral gate

From `TARGET`:

```
pnpm -C "$TARGET" build
pnpm -C "$TARGET" test
```

Run the manual verification from `plan.md` as well. Report observed results, not
expected results.

A MOCK run proves plumbing only. It does not prove model-driven behavior. For a
behavioral claim about the real agent runtime, run under the `claude` runtime and
distinguish that result from a MOCK one.

If any required verification fails: keep the worktree, diagnose, return to the
repair step, and never describe the change as complete. If a step cannot run,
state exactly which step you skipped and why.

## 7. Adversarial gate

The behavioral gate proves the code runs. This gate proves it is *correct*. A
green build and passing string or grep checks routinely coexist with real runtime
and data-integrity bugs. Treat this as a separate pass, not a formality.

Read the complete diff once more and check for:

- runtime or data-integrity bugs hidden by static checks;
- edits outside `plan.md`;
- accidental generated files;
- stale or misleading comments;
- tests that reproduce implementation details rather than behavior;
- unnecessary abstractions;
- changes that break the controller/target boundary.

Commit the verified change with git. Do not push, land, or remove the worktree
unless the user asks. Report what changed, the branch, each verification step as
PASS, FAIL, or SKIPPED, the runtime you used (MOCK or CLAUDE), and whether the
work was delegated or edited directly. Then let the user decide how to land it —
`close-worktree` lands it locally, `close-pr` lands it through a merged PR.
