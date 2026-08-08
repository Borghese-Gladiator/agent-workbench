---
name: implement-feature
description: Implement a feature or fix in the agent-workbench repository by using Agentic Workbench to modify its own code safely. Use for requests to add, change, fix, refactor, or implement behavior in this repo. Plan first, create an isolated target worktree, run the implementation against that worktree from a stable controller checkout, independently verify the resulting diff and behavior, repair if necessary, then land with close-worktree. Do not use for driving changes in unrelated repositories.
---

# Implement a feature in agent-workbench

Implement changes to this repository using Agentic Workbench itself whenever practical.

Treat self-hosting as two separate roles:

- **Controller** — the stable checkout/runtime running Agentic Workbench.
- **Target** — an isolated worktree containing the code being changed.

Never use a checkout as both controller and target during the same live task.

The flow is a delegate-then-independently-verify loop, not a straight line: the
implementation is delegated to AWB, its result is verified against the plan and
the real diff (never against the task's own success message), and a defect routes
back into a bounded repair loop before the change is ever landed.

```
implement-feature
├── 1. plan.md                      smallest correct change
├── 2. create-worktree ───────────► TARGET   (must differ from the controller)
│
├── 3. delegate ──────────────┐
│      run-workbench-task ─► TARGET   (controller = stable / pinned checkout)
│                              │
├── 4. verify: diff exists? matches plan? build + tests green?
│                              │
│      └── defective? ─► 5. repair task ─► back to 4     (cap: ~2 rounds, then
│                                                          diagnose directly)
│
├── 6. behavioral verification       build / test / manual, observed not expected
├── 7. adversarial diff review       correctness the string-checks miss
└── 8. close-worktree                only on green
```

Read `AGENTS.md` before planning. Treat it as authoritative for architecture,
repository layout, coding rules, and prohibited patterns.

For changes under the Temporal worker, also read
`workers/temporal-worker/src/activities/AGENTS.md`.

## 1. Write the plan

Before any non-trivial edit, create `plan.md` in the target unit of work:

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

Keep the plan scoped to the smallest correct change.

If the expected implementation spans more than a few files, explain why.
Do not expand scope merely to clean up nearby code.

Planning is not completion. Unless explicitly asked for plan-only work,
continue through implementation and verification in the same task.

## 2. Create the target worktree

For non-trivial work, invoke `create-worktree`.

Capture the resulting worktree path and treat it as `TARGET`.

From this point forward:

- Run target repository commands with an explicit `git -C "$TARGET"` or
  `pnpm -C "$TARGET"`.
- Make all implementation edits inside `TARGET`.
- Do not modify the controller checkout as part of the feature.
- Use one worktree per independent unit of work.

Do not infer success from daemon or database state. The target worktree and its
Git diff are authoritative for whether source code changed.

## 3. Run the implementation through Agentic Workbench

Prefer having Agentic Workbench perform the implementation rather than directly
editing `TARGET`.

The controller runtime must come from a stable checkout or pinned build that is
not being edited by the task.

Give the implementation task:

- the user's requested behavior;
- the absolute `TARGET` path;
- the requirements from `plan.md`;
- the instruction to make the smallest correct change;
- the requirement to add focused tests;
- the requirement not to land, push, or delete the worktree.

Run the task against `TARGET` (the `run-workbench-task` skill drives the boot →
contract → lifecycle sequence).

Do not run `awb up --dev` from a checkout that the task can edit. A source save
can hot-reload the controller while it is orchestrating itself.

If the target needs a runtime built from its own code for verification, build it
after implementation and run it in pinned mode.

Until TASK-59 lands, do not run two live AWB stacks concurrently because their
ports and queue collide.

## 4. Inspect the result independently

Do not accept the task's success message as proof.

After the implementation task finishes:

1. Inspect `git -C "$TARGET" status`.
2. Inspect the complete target diff.
3. Compare the diff against `plan.md`.
4. Check for unrelated edits, missing tests, architecture violations, or
   unnecessary abstraction.
5. Confirm the implementation actually addresses the requested behavior.

Important repository invariants include:

- Keep TypeScript strict; do not introduce `any`.
- Validate process and persistence boundaries with Zod.
- Keep I/O out of `@awb/workflow`.
- Put Temporal I/O in `workers/temporal-worker/src/activities/`.
- Route writes through the daemon.
- Do not let agents decide phase completion.
- Prefer self-explanatory code over comments.
- Keep the implementation to as few slices as the work honestly requires.

If the diff is empty, incomplete, incorrect, or materially outside the plan,
do not proceed to landing — route to the repair loop.

## 5. Repair until the target is correct

When verification reveals an implementation defect, prefer another focused AWB
task against the same `TARGET`.

Give the repair task:

- the observed failure;
- the relevant diff or test output;
- the expected behavior;
- an instruction to correct only the defect without broadening scope.

Use direct source editing only when one of these is true:

- Agentic Workbench cannot execute the required repair;
- repeated delegated attempts fail for the same reason;
- the requested change is trivial enough that delegation adds no useful
  verification.

If direct editing is used, state that explicitly in the completion report.

Do not endlessly retry. If the same substantive failure survives two focused
repair attempts, stop delegating, diagnose it directly, and either repair it or
report the blocker accurately. Each repair pass returns to step 4 — the loop
exits only when the diff is correct and matches the plan.

## 6. Verify the target (behavioral gate)

From `TARGET`, run:

```bash
pnpm -C "$TARGET" build
pnpm -C "$TARGET" test
```

Run the manual verification specified in `plan.md` as well.

Report observed results, not expected results.

A MOCK runtime run proves plumbing only. It does not prove model-driven
behavior.

For behavioral claims involving the real agent runtime, perform a
`claude`-runtime run and distinguish its result from MOCK verification.

If any required verification fails:

- keep the worktree;
- diagnose the failure;
- return to the repair step;
- never describe the change as complete.

If a verification step cannot be run, state exactly which step was skipped and
why.

## 7. Review the final diff (adversarial gate)

The behavioral gate proves the code runs; this gate proves it is *correct*. A
green build and passing string/grep-based checks routinely coexist with real
runtime and data-integrity bugs — treat this as a separate pass, not a formality.

Before landing, perform one final adversarial read of the complete diff.

Check especially for:

- runtime or data-integrity bugs hidden by static/string-based checks;
- edits outside `plan.md`;
- accidental generated files;
- stale or misleading comments;
- tests that only reproduce implementation details rather than behavior;
- unnecessary abstractions;
- target changes that accidentally affect the controller/self-host boundary.

Do not substitute grep-based QA for correctness review.

## 8. Land the verified target

Only after both gates pass, invoke `close-worktree`.

Let that skill own rebasing, fast-forwarding local `main`, worktree removal, and
branch cleanup.

Commit with Git as required by the workflow.

Do not push unless explicitly asked.

## Completion report

Report:

```text
Implemented:
- <behavior actually changed>

Target:
- <worktree / branch>

Verification:
- build: PASS | FAIL | SKIPPED
- tests: PASS | FAIL | SKIPPED
- manual: PASS | FAIL | SKIPPED
- runtime: MOCK | CLAUDE | NOT RUN

Implementation:
- delegated to AWB | direct | mixed

Notes:
- <material caveats only>
```

Never claim success based solely on:

- an AWB task reporting completion;
- daemon state;
- database row counts;
- grep/string-match QA;
- a clean controller checkout.

The target worktree diff plus observed verification are the source of truth.
