# Dogfooding the workbench on this repo — status (TASK-77)

**Status: still blocked, and the blocker has not moved. Recorded here rather than quietly marked
done.**

## What the ticket asks for

> A branch + draft PR on this repo produced by the workbench, with a short writeup of what was
> awkward.

Not "a PR that changes this repo" — a PR **the workbench produced by driving a task**. That
distinction is the whole point of the ticket, and it is why this one is not being checked off.

## Where it actually stands

The partial run on 2026-08-15 got further than the ticket's own note suggests. Discovery, contract,
plan, prepare and **implement all succeeded against the real repo**: the agent correctly recognized
TASK-78 was already implemented on `main` and produced a genuinely good test-only diff (+9
`branch.test.ts`, +24 `worktree.test.ts`, a real `createWorktree` slug-path assertion).

It stalled at `verify`, and the TODO's own note says: *"reopen once TASK-104 lands."*

**TASK-104 has not landed.** It is implemented, but it sits in an open draft PR against `main`, not
in `main`. Driving the dogfood now would drive it through the gate machinery TASK-104 removes —
reproducing exactly the stall that blocked the run in August. That is not a dogfood, it is a
re-enactment.

## Unblock condition

Merge the Group AA PR (TASK-104/105/106/107). Then drive one small, self-contained task on this
repo end to end. With the autonomy pivot in, the terminal state is a draft PR rather than the
pr-readiness gate the original ticket text still assumes — so the ticket's "stopping at the
pr-readiness gate" wording is itself now stale and should be read as "to its draft-PR terminal".

## Friction captured in the meantime

This backlog pass did not run through the workbench, but it ran **against** this repo at length,
and surfaced friction worth recording:

- **Stale backlog checkboxes.** TASK-123, 126 and 127 shipped in PR #41 and stayed `[ ]` in
  `docs/TODO.md`. Anyone picking up the backlog would have re-implemented shipped work; the first
  thing this pass had to do was verify each open item against the code. A ticket is not open
  because its box is unticked.
- **A ticket premise can be wrong about its own repo.** TASK-119 asserts `build-ui` has no
  structured design-spec input. The skill has instructed writing a `design.md` since it shipped.
  The real gaps were different and narrower — see the design.md writeup.
- **The `pre-push` hook is flaky under load.** Three `packages/qa` browser tests time out on real
  Chromium contention when several suites run concurrently, and pass in isolation. The hook then
  blocks a push that has nothing to do with them. Worth a standing note: the flake is in the test
  environment, not the tests.
- **`repository.trusted` already existed** as a persisted column with an `awb repo approve` writer,
  while `first-time-repository-trust` sat in the gate enum with no runtime path at all. TASK-104's
  "move repo-trust out of the gate machinery" was closer to deleting a phantom than to building
  something.

## Why this is not being marked done

Marking TASK-77 complete on the strength of "we changed the repo a lot" would be the exact
dishonesty the workbench's own completion machinery exists to prevent — an agent declaring success
because work happened, rather than because the acceptance claim was met. The claim here is a
workbench-produced PR. There isn't one yet.
