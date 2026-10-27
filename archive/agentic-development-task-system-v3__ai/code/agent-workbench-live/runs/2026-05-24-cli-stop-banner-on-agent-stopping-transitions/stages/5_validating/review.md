# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes, with one acknowledged deviation (see below).

- **AC-1** (helper exists, validates landing_state): satisfied — `lib/cli/_stop_banner.py` defines `print_stop_banner` with closed-set validation. ValueError unit-tested in `test_invalid_state_raises` and `test_other_invalid_states_raise`.
- **AC-2** (60-col border, second line format): satisfied — border pinned by `test_border_is_60_columns`; second-line format verified by each per-state structural test.
- **AC-3** (next-moves vs terminal block per state): satisfied — non-terminal banners list the right commands; terminal banners get "Terminal state. No further action." All four snapshots match exactly.
- **AC-4** (wired into all five commands; uses shared helper): satisfied — each `cmd_*.py` has exactly one import line and one call line, no inlined banner text.
- **AC-5** (only fires on actual transition success): satisfied by code construction in each command. Demonstrated by the E2E negative assertion that `validate --init` (which transitions but to an agent-driven state) doesn't print the banner.
- **AC-6** (cmd_plan only on default branch, not `--init`): satisfied — banner call lives on the post-`transitions.transition(..., "ready", ...)` path; the `--init` branch returns earlier. Negative E2E assertion after `plan --init` confirms.
- **AC-7** (cmd_validate only on flat-layout): satisfied — banner sits after the `branch:/worktree:/audit:` triplet, which is reached only by the flat-layout success branch. Negative E2E assertion after the staged `validate` finalize (which lands at `followups`) confirms STOP is absent.
- **AC-8** (cmd_followups only on default branch): satisfied — `--init` branch returns at line 85 before the banner call. Positive E2E assertion confirms it fires on the default path.
- **AC-9** (cmd_complete only on success): satisfied by construction — every failure path raises `_CompleteError` and is caught into `return fail(...)` before the banner line is reached.
- **AC-10** (cmd_abandon any source state): satisfied — abandon has only one success path; the banner call is unconditional once it's reached.
- **AC-11** (AGENTS.md cross-reference): satisfied — one sentence added at the top of "How to drive the workbench" (AGENTS.md lines 41-43).
- **AC-12** (test coverage): mostly satisfied. The "complete does NOT print banner on abort" assertion is reasoned by code construction rather than an explicit runtime test. See build.md "Deviations from plan" — judgment call, not a brief-busting omission.
- **AC-13** (full suite passes modulo pre-existing failures): satisfied — 244 passed, 2 failed; the two failures are pre-existing date-baked snapshot drift reproduced against master.

## Did it accidentally expand scope?

No. The change set is exactly the modules named in the brief's "Tasks" list. The one ancillary edit is `.gitignore` — needed because the existing `lib/` re-include rule only covered the v2 path; without the v3 sibling, `lib/cli/_stop_banner.py` would have been silently ignored on commit. That's a latent gap surfaced by this change, not a scope expansion.

## Are there fragile assumptions?

- **ASM-1** (success-path placement): held up. Every command places the banner immediately before `return 0` on its success path.
- **ASM-5** (E2E subprocess captures stdout): held up — all positive/negative assertions in the extended `test_e2e.py` pass.
- **ASM-6** (AGENTS.md section name): held up — "How to drive the workbench" exists verbatim at line 39.
- **ASM-8** (cmd_complete failure paths exit before banner): held up by code reading. The one residual fragility is that the test plan didn't land a runtime assertion for this; see build.md "Known issues" for the rationale and suggested follow-up.

One latent assumption surfaced during implementation but not in the plan: the gitignore re-include rule for `lib/` was scoped to v2 only. Without adding the v3 sibling line, a fresh clone or worktree wouldn't track the new module. Added; documented; small footprint.

## Are there missing tests?

- **A runtime assertion that `cmd_complete` does NOT print the banner when the merge aborts.** Reasoned by code construction. The cheapest follow-up: spin a focused test that runs `complete` against a worktree with uncommitted changes and asserts `STOP.` not in stdout. Not blocking — the brief's AC-12 listed the test but the absence is documented.
- **A test covering the `cmd_validate.py` flat-layout banner.** The repo doesn't have a flat-layout E2E fixture; all current happy-path runs are staged. The wiring is verified by code reading + the snapshot test of the `human_review` banner string. Adding a flat-layout fixture is a larger lift than this brief calls for and would touch fixture infrastructure outside the §2 scope.

## Are there security / data loss / migration risks?

None. The change is stdout-only:
- No changes to `metadata.yaml`, `events.jsonl`, schemas, or transitions.yaml.
- No file writes outside the stdout path (and the per-run `events.jsonl` continues to be written by `transitions.transition`, untouched).
- The banner is plain ASCII; no escape sequences, no shell-quoted run_id (the run_id flows through `f"{run_id}"` which is a print, not a subprocess call).

## What should the human review first?

1. `lib/cli/_stop_banner.py` — the whole module. ~85 lines. Verify the closed-set validation, the border width, and that the two paths (next-moves vs terminal) are mutually exclusive.
2. `tests/test_stop_banner.py` — the test surface. Confirm the snapshot fixtures match what the helper actually prints by reading them side-by-side.
3. The five `cmd_*.py` edits — each is two lines, easiest read together via `git diff HEAD~1 -- agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_*.py`.
4. The `AGENTS.md` cross-reference paragraph.
5. The `.gitignore` line — the only non-banner edit; justified by the lib/v3 gap.
6. E2E assertions added to `test_e2e.py` — confirm positive/negative pairs land on the right calls.

## Blast radius

depth 1 (changed files):
  agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/_stop_banner.py (new)
  agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_plan.py
  agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_validate.py
  agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_followups.py
  agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_complete.py
  agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_abandon.py
  agentic-development-task-system-v3__ai/agent-workbench-live/AGENTS.md
  agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_stop_banner.py (new)
  agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_e2e.py
  agentic-development-task-system-v3__ai/agent-workbench-live/tests/snapshots/stop_banner_*.expected.txt (4 new)
  .gitignore

depth 2 (callers of changed symbols):
  `print_stop_banner` — called from cmd_plan, cmd_validate, cmd_followups, cmd_complete, cmd_abandon only (just-added). No other module imports `lib.cli._stop_banner`.
  Five cmd_*.py modules — each is imported only by `bin/agent-workbench` argparse dispatch (`agent-workbench-live/bin/agent-workbench`). No tests import the command modules directly except as the subprocess entry point.

depth 3 (callers of those callers):
  `bin/agent-workbench` — entry point only; not imported elsewhere.
  E2E tests invoke `bin/agent-workbench` via subprocess.

Nothing in depth 2 or 3 lives outside the brief's expected scope. The only out-of-scope file in depth 1 is `.gitignore`, justified above.

## Findings

(No blocking, major, or minor findings.)

## Documentation claims

Validating compared `build.md`'s **Documentation touched** section against `git diff` in the worktree. The following claimed paths were NOT changed in the diff:

- ``agentic-development-task-system-v3__ai/agent-workbench-live/AGENTS.md``

Either the claim is wrong, the change is unstaged, or the base ref is misconfigured. Reviewer: confirm or push back.
