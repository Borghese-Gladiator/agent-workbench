# Brief

## Goal

Land a CLI stop banner that is printed by every workbench command whose transition lands in a state the agent does not drive. The banner is the last thing on stdout, names the landing state, says who owns it, and lists the exact next commands the human would invoke. One shared helper drives the format so every call site stays in sync.

The structural gap this closes: today, transitions that hand off to the human (`planning -> ready`, `validating -> human_review`, `followups -> human_review`, `human_review -> done`, any state `-> abandoned`) print only a one-line `<id>: A -> B` and (sometimes) an artifact path. There is nothing in the agent's most recent tool output that flags the transition as a hard handoff, which is how the auto-merge-on-complete dogfood run drove straight through `human_review` into `/complete` without pausing.

## User-facing behavior

After this change, the stdout of these five commands ends with a bordered STOP banner whenever the transition lands the run in `ready`, `human_review`, `done`, or `abandoned`:

- `agent-workbench plan <id>` (final, when it lands `planning -> ready`)
- `agent-workbench validate <id>` (flat-layout path that lands `validating -> human_review` directly)
- `agent-workbench followups <id>` (staged path that lands `followups -> human_review`)
- `agent-workbench complete <id>` (lands `human_review -> done`)
- `agent-workbench abandon <id>` (lands any non-terminal state -> `abandoned`)

Banner shape (60-column wide, exact format pinned by a snapshot test):

```
============================================================
STOP. State: human_review (human-owned).
The run is staged for the human's review and decision.

Next moves (human-triggered):
  agent-workbench complete <run_id>  — accept and merge
  agent-workbench bounce <run_id>    — send back to building
  agent-workbench abandon <run_id>   — abandon the run
============================================================
```

The banner is the last thing in stdout. The existing transition line (`<id>: A -> B`) and any artifact-path line (e.g. `HUMAN_REVIEW.md`) still print first, in their existing order.

## Acceptance criteria

1. A new module `lib/cli/_stop_banner.py` exports `print_stop_banner(landing_state: str, run_id: str) -> None`. It supports exactly four landing states: `ready`, `human_review`, `done`, `abandoned`. Calling it with any other state raises `ValueError`.
2. The banner is bordered top and bottom with a 60-character `=` rule. The second line is exactly `STOP. State: <landing_state> (<owner>-owned).` where `<owner>` is `human` for `ready`/`human_review`, `no one` for `done`/`abandoned`.
3. The "Next moves" block lists:
   - `ready`: `agent-workbench start <run_id>` — approve plan and create the worktree.
   - `human_review`: `agent-workbench complete <run_id>` / `bounce <run_id>` / `abandon <run_id>`.
   - `done`: no next moves (the block is omitted or replaced by a single "Terminal state. No further action." line).
   - `abandoned`: no next moves (same treatment as `done`).
4. The banner is wired into all five commands listed above. The wiring uses the new helper — no command inlines the banner text.
5. The banner only prints when the transition actually lands the run in one of the four states. If `plan` fails its gate, no banner. If `validate` exits because review/QA caught an issue, no banner. If `complete` aborts on a dirty worktree or merge conflict, no banner.
6. `lib/cli/cmd_plan.py` only prints the `ready` banner when the run actually transitions to `ready` on this invocation. It does NOT print the banner on the `draft -> shaping -> planning` --init paths nor on a final `plan` invocation that fails the planning gate.
7. `lib/cli/cmd_validate.py` prints the banner only on the flat-layout path that lands `validating -> human_review` directly. The staged path that lands `validating -> followups` does NOT print the banner (the agent still drives `followups`).
8. `lib/cli/cmd_followups.py` prints the banner only on the staged `followups -> human_review` transition (default invocation, not `--init`).
9. `lib/cli/cmd_complete.py` prints the banner only when the run actually reaches `done` (i.e. the merge + transition succeeded). A `MergeConflict` exit must not print the banner.
10. `lib/cli/cmd_abandon.py` prints the banner whenever the abandon transition succeeds, from any source state.
11. `agent-workbench-live/AGENTS.md` has one sentence cross-referencing the banner under "How to drive the workbench" (or equivalent existing section): when you see a `STOP.` banner in CLI output, your session ends and the listed next moves are the human's call.
12. Test coverage:
    - Unit tests for `_stop_banner.print_stop_banner`: four states × assert on banner text + next-command list. Use `capsys`.
    - One snapshot fixture per landing state for the exact banner format (catches wording drift).
    - Existing E2E `TestE2EHappyPath.test_happy_path` is extended to assert `STOP.` appears in stdout after the `followups` and `complete` calls. (Plus negative assertion that it does NOT appear after `shape`, `plan --init`, or `start`.)
    - A unit test confirms `complete` does NOT print the banner when the transition aborts (e.g. dirty worktree, merge conflict).
13. The full `agent-workbench-live/tests/` suite still passes (the 2 pre-existing date-baked snapshot drift failures on master are not counted against this run).

## Non-goals

- Hard enforcement. The agent can run past the banner; this is a nudge, not a block.
- Hooks-based call interception or runtime-coupling. The banner is plain stdout from the CLI.
- Banners on transitions that the agent itself drives (`draft -> shaping`, `shaping -> planning`, `ready -> building`, `building -> validating`, `validating -> followups`). Adding banners there dilutes the signal.
- Per-state contract files in `docs/states/<state>.md`. `docs/lifecycle.md` already carries state contracts; this task is purely about runtime visibility.
- Reformatting the existing transition-success print or changing the order of prior stdout lines. The banner is purely additive.
- Coloring / ANSI escapes. Plain ASCII only — same style as the rest of the CLI.
- Internationalization. Banner text is English-only, same as every other CLI string.

## Good examples

- After `agent-workbench followups <id>` succeeds and transitions `followups -> human_review`, the last block of stdout is the bordered `human_review` STOP banner. The agent reads its last tool output, sees STOP, and stops.
- After `agent-workbench complete <id>` succeeds (worktree merged, run is `done`), the last block of stdout is the `done` banner with "Terminal state. No further action." The agent does not invoke any further workbench commands on this run.
- After `agent-workbench abandon <id>` from any non-terminal state, the last block of stdout is the `abandoned` banner.

## Bad examples

- The banner prints when `plan --init` runs (wrong — `--init` does not land at `ready`; that's the `draft -> shaping` and similar transitions).
- The banner prints on `validate` when the staged path lands at `followups` (wrong — the agent still drives `followups`; only the flat-layout direct-to-`human_review` validate should print it).
- Two commands print slightly different banners for the same landing state because they each inlined the text (wrong — single source of truth in `_stop_banner.py`).
- The banner prints on `complete` even though the merge failed and the run is still in `human_review` (wrong — only print on actual transition success).
- The banner appears before the transition line in stdout (wrong — must be the last thing).
- The banner uses Unicode box-drawing characters or color codes (wrong — plain ASCII, matches existing CLI style).

## Constraints

- Python 3 only. No new dependencies. The helper is a single file under `agent-workbench-live/lib/cli/`.
- Must not change the wire format of `events.jsonl` or `metadata.yaml`. The banner is a stdout-only concern.
- The helper must not import from `cmd_*.py` modules (avoid circular import — cmd modules import the helper, not the reverse).
- Banner width fixed at 60 columns to match existing CLI output style.
- Plain ASCII only (`=`, letters, digits, basic punctuation). No Unicode dashes, no ANSI escape codes, no emoji.
- The helper takes the landing state as a string and validates it against the closed set `{ready, human_review, done, abandoned}`. Any other value raises `ValueError` — defensive, since the call sites are internal.
- Each call site's banner trigger is gated on the actual transition succeeding (i.e. placed after the state mutation, not before).

## Assumptions

- **ASM-1.** `cmd_plan.py`, `cmd_validate.py`, `cmd_followups.py`, `cmd_complete.py`, and `cmd_abandon.py` each have a single, identifiable success path where the transition has been recorded and the existing transition-success print has just happened. The banner call goes immediately after that print, before the function returns.
- **ASM-2.** The flat-layout vs staged-layout split in `cmd_validate.py` is already encoded in the command (one branch lands at `human_review`, the other at `followups`). The banner call is gated on the same branch condition; no new branching logic is added.
- **ASM-3.** `cmd_complete.py`'s success path is unambiguous: when the function reaches its final transition-success print, the run is in `done`. Failure paths (dirty worktree, merge conflict) exit earlier via `sys.exit(1)` or a raised exception, before the banner call.
- **ASM-4.** `cmd_abandon.py` only has a success path (or a clean failure that exits before the print); a successful abandon always lands in `abandoned` regardless of source state.
- **ASM-5.** The existing E2E `TestE2EHappyPath.test_happy_path` captures CLI stdout in a way that lets a regex/`in` assertion against `STOP.` work. (If it currently asserts on exit code only, the test will be extended to also capture stdout — same harness, no test infrastructure rewrite.)
- **ASM-6.** `AGENTS.md` already has a "How to drive the workbench" (or near-equivalently named) top-level section where one sentence about the banner can be added. If the section title differs, the planner picks the closest match — this is a one-line edit, not a structural rewrite of AGENTS.md.
- **ASM-7.** No other CLI command lands the run in `ready`/`human_review`/`done`/`abandoned`. The mapping in the brief is exhaustive.

## Suggested QA scenarios

- **QA-1.** Drive a fresh happy-path run from `/new-run` through `/complete`. Assert STOP banner appears in stdout after `plan` (ready), `followups` (human_review), and `complete` (done). Assert it does NOT appear after `shape`, `plan --init`, `start`, or `validate --init`.
- **QA-2.** Drive a run that uses the flat-layout `/validate` path that lands directly at `human_review` (no `followups` stage). Assert STOP banner appears after `validate`. Confirm the staged path's `validate` (which lands at `followups`) does NOT print the banner.
- **QA-3.** From a run in `human_review`, run `/abandon`. Assert STOP banner appears with state `abandoned`.
- **QA-4.** From `building` or `planning`, run `/abandon`. Assert STOP banner appears regardless of source state.
- **QA-5.** Run `/complete` against a run with a dirty worktree (or a merge conflict). Assert the command exits non-zero AND the STOP banner does NOT appear in stdout (the run is still in `human_review`).
- **QA-6.** Snapshot diff each of the four banners (one fixture file per state in `tests/fixtures/stop_banner/`). Any wording drift fails the snapshot test in PR review.
- **QA-7.** Unit test: calling `print_stop_banner("planning", "id")` raises `ValueError`. Calling it with any of the four valid states writes the expected banner to stdout and returns `None`.
