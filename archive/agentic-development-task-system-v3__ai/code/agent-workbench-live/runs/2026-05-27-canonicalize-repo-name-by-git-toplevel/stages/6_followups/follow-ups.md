# Follow-ups

---
title: Add subprocess timeout to show_toplevel git call
motivation: ASM-001 claimed the new `show_toplevel` helper would mirror the 5-second timeout from `lib/runs.py:_git_common_dir`, but the actual implementation routes through `lib/repos.py:_git` which calls `subprocess.run` with no timeout. On a hung filesystem or a wedged git index lock, `new-run` could block indefinitely before any worktree is created. Low likelihood, latent hang risk.
suggested_scope: Add a `timeout=5` (or matching constant) to the `subprocess.run` call in `lib/repos.py:_git`, or pipe an explicit timeout through `show_toplevel`. In scope - the timeout itself, one unit test that uses `unittest.mock` to assert the kwarg is passed (no real hang test). Out of scope - reworking `_git` into a more general helper, changing other repos.py call sites' behavior.
category: bug_risk
---

The validating reviewer flagged this in §"Are there fragile assumptions?" point 2: "ASM-001 said the pattern would mirror `_git_common_dir`'s 5-second timeout; in fact `_git` in `lib/repos.py:27-30` has no timeout." The fix is a one-line kwarg; the value is that `new-run` keeps its "fail fast and fall back to basename" semantics even on a sick filesystem.

---
title: Reconcile DR-003 with the .resolve() call in show_toplevel
motivation: Decision record DR-003 explicitly said "do not normalize further (no realpath, no string-equality canonicalization beyond what git itself does)". The shipped code in `lib/repos.py:65` calls `Path(raw).resolve()` on git's output. This is a no-op in practice today (git already returns the resolved real path of toplevel), but the code and the decision contradict each other - the next maintainer will be confused about which rule is canonical.
suggested_scope: Either (a) drop the `.resolve()` call to match DR-003, or (b) amend DR-003's text in `plan.md` to acknowledge a defensive `.resolve()` on git's output. Pick one; do not ship both. Add a 1-line code comment citing the chosen rationale. In scope - the code or the doc, plus a quick unit-test sanity check. Out of scope - revisiting cross-machine path canonicalization (still a non-goal).
category: tech_debt
---

The reviewer flagged this in §"Are there fragile assumptions?" point 1. It's strictly cosmetic today but the kind of drift that compounds. Option (a) is the lighter touch.

---
title: Emit drift warning when canonical worktree parent differs from existing pre-canonicalization parent
motivation: The user's original report described real drift - three different `<worktrees_dir>/<repo>-subpath/` parents for the same monorepo. This run fixed *future* new-runs but explicitly deferred (DR-002) the one-line warning that would signal "you have an existing pre-canonicalization parent at `<worktrees_dir>/foo-subpath/` but the canonical one would be `<worktrees_dir>/foo/`." Without that warning, the next user to hit the same drift will be just as surprised as the original reporter was, because nothing in the CLI's output tells them why their worktrees suddenly live in a new parent.
suggested_scope: Add a non-fatal warning helper (likely in `_common.py` per DR-002's option b, or a structured `Warning` event per option c) and wire it into `cmd_new_run.py` immediately after `_canonical_repo_basename` resolves. Detect the case where `<worktrees_dir>/<canonical>/` does NOT exist but at least one sibling `<worktrees_dir>/<canonical>-*` does. Emit one stderr line plus an event-log entry. In scope - the warning itself and one integration test that creates a fake sibling dir and asserts the warning fires. Out of scope - re-homing existing non-canonical worktrees, fixing the 578 orphan test-fixture dirs.
category: scope_extension
---

DR-002 explicitly defers this with the rationale "no existing non-fatal warning pattern; the brief conditioned this on 'only if no extra effort beyond a one-line warning'." The follow-up gets to pick the warning shape carefully. Closing TODO §6 without this leaves the original user-reported pain partially unresolved for future users hitting the same drift.

---
title: Add integration test for --repo-name override combined with deep subpath
motivation: The new unit tests in `tests/test_run_ids.py` cover the two arms of `_canonical_repo_basename` separately (subpath-resolves-to-toplevel and override-wins-via-cmd_new_run-static-read), but not the interaction at the integration level - i.e. invoking `new-run --repo-path <subpath> --repo-name <override>` end-to-end and asserting the override wins over the canonical basename. The current branch logic in `cmd_new_run.py:71-76` is trivially safe (short-circuit before `_canonical_repo_basename`), so this is a coverage gap rather than a bug, but the contract is load-bearing for users who *want* a non-canonical name.
suggested_scope: One new integration test in the existing `test_new_run` (or similar) module that invokes the CLI end-to-end with both flags set and asserts the resulting `repo_name` matches the override, not the toplevel basename. In scope - one happy-path test plus one assertion that the git call is *not* invoked when the override is present (mock `show_toplevel` and assert not-called). Out of scope - refactoring the existing override branch.
category: tech_debt
---

Flagged by the reviewer in §"Are there missing tests?" first bullet. Trivially small; locks in the override contract at the integration layer.

---
title: Fix or re-pin date-sensitive snapshots in tests/test_human_review.py
motivation: Two snapshot tests (`TestSnapshotRender.test_happy_snapshot`, `test_bounce_pass2_snapshot`) fail today because their fixtures are pinned to `2026-05-22-*-snap` run IDs but the renderer produces `2026-05-27-*-snap`. **This is NOT a regression from the canonicalize-repo-name run** - the validating subagent confirmed by stashing this branch's diff and re-running. But the failures were surfaced while validating this run, the suite is currently red on master for them, and CI signal is muddied as long as they linger.
suggested_scope: Either (a) freeze the rendering clock via a fixture (preferred - matches the deterministic-output convention this repo's tests use elsewhere), or (b) re-pin the snapshot fixtures to a clock-independent placeholder pattern. In scope - the two named tests in `tests/test_human_review.py` and any small fixture/helper change required to freeze the date. Out of scope - reworking the human-review snapshot strategy more broadly; auditing other date-sensitive tests in the suite (separate audit if desired).
category: bug_risk
---

The reviewer surfaced this in §"What should the human review first?" point 4 and the QA report's "Full discover" section confirmed it. Flagging as `bug_risk` because the tests are red - even though not a regression from this run - and a red suite undermines future bisects and CI gating.
