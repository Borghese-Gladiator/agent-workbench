# Implementation plan

## Current repo understanding

The workbench CLI lives at `agent-workbench-live/lib/cli/cmd_*.py`. Each subcommand owns its own module; the entry point in `agent-workbench-live/bin/agent-workbench` dispatches by argv. State transitions are funneled through `lib.transitions.transition(...)`, called from inside `with locks.acquire(...)` blocks at the bottom of each command's `run()` function. The standard pattern is:

1. Load metadata, validate state.
2. Stage / verify artifacts.
3. Emit pre-transition events (`ReviewCompleted`, `QACompleted`, `AuditRendered`, `HumanHandoffCreated`, `FollowupsRecorded`, `WorktreeMerged`, etc.).
4. Call `transitions.transition(...)` (rejects via raised `TransitionError`).
5. Update metadata via `metadata.update(...)`.
6. Best-effort metrics writer.
7. `print(f"{run_id}: A -> B")` plus any path/audit/branch lines specific to the command.
8. `return 0`.

The banner injection point in every wiring is **between step 7's last `print` and step 8's `return 0`**. That is: after the transition is durably recorded, after metrics, after every existing stdout line that downstream tooling parses. Adding lines after the existing prints is purely additive — no command currently relies on the existing prints being the last bytes of stdout.

Five files contain agent-stopping transition success paths, located precisely:

- `lib/cli/cmd_plan.py:264` — `print(f"{run_id}: planning -> ready")` then `return 0`. This is the final-plan path (the `default` branch). The `--init` branch returns at line 154 and does NOT land at `ready` — no banner there.
- `lib/cli/cmd_validate.py:444-447` — flat-layout path: prints `validating -> human_review`, `branch:`, `worktree:`, `audit:`, then `return 0`. This is the only validate path that lands the run in `human_review`; the staged path lands at `followups` (line 399) and does NOT get a banner. The `--init` branch (line 273) also does NOT get a banner (it lands at `validating`).
- `lib/cli/cmd_followups.py:190-192` — the staged path that lands `followups -> human_review`. The `--init` branch (line 84) lands at `followups` and does NOT get a banner.
- `lib/cli/cmd_complete.py:137-140` — prints `human_review -> done`, `completion_ref: …`, and a merge line if the merge actually happened. All error paths raise `_CompleteError` or `TransitionError` which return early via `fail(...)` before reaching the print — so simply placing the banner call after line 140 is safe.
- `lib/cli/cmd_abandon.py:55-56` — prints `<run_id>: -> abandoned`, `reason: …`. All failure paths exit earlier via `fail(...)`.

The "How to drive the workbench" section in `agent-workbench-live/AGENTS.md` is at lines 39-75. A one-sentence cross-reference fits cleanly under the heading, before the "Command -> state map" table at line 49.

The tests use subprocess capture (`capture_output=True, text=True`) so `r.stdout` is a plain string — straightforward `self.assertIn("STOP.", r.stdout)` assertions land easily in `TestE2EHappyPath.test_happy_path` after the `followups` and `complete` calls. The existing assertions on lines 195 and 218 are sibling-friendly insertion points. The bounce-loop test's second `followups` (line 313-316) is also a useful coverage point.

Snapshot tests in this repo write `.expected.md` files under `tests/snapshots/`. Pattern: `if WRITE_SNAPSHOTS: snapshot_path.write_text(rendered)` env-guarded re-baseline, with `assertMultiLineEqual(expected, rendered)` on the read path.

## Relevant files

- `lib/cli/cmd_plan.py` — wire banner on `planning -> ready` success.
- `lib/cli/cmd_validate.py` — wire banner on flat-layout `validating -> human_review` success (line ~448).
- `lib/cli/cmd_followups.py` — wire banner on staged `followups -> human_review` success (line ~193).
- `lib/cli/cmd_complete.py` — wire banner on `human_review -> done` success (line ~140).
- `lib/cli/cmd_abandon.py` — wire banner on `-> abandoned` success (line ~56).
- `lib/cli/_stop_banner.py` — NEW. The single helper module.
- `AGENTS.md` — add one-sentence cross-reference under "How to drive the workbench".
- `tests/test_stop_banner.py` — NEW. Unit tests for the helper (four states + ValueError on invalid state) and snapshot fixtures.
- `tests/test_e2e.py` — extend `TestE2EHappyPath.test_happy_path` and (optionally) `TestE2EBounceLoop.test_bounce_loop` and `TestE2EAbandon` for `STOP.` substring assertions.
- `tests/snapshots/stop_banner_ready.expected.txt` — NEW snapshot.
- `tests/snapshots/stop_banner_human_review.expected.txt` — NEW snapshot.
- `tests/snapshots/stop_banner_done.expected.txt` — NEW snapshot.
- `tests/snapshots/stop_banner_abandoned.expected.txt` — NEW snapshot.

## Proposed changes

### 1. New module: `lib/cli/_stop_banner.py`

Single public function:

```python
def print_stop_banner(landing_state: str, run_id: str) -> None
```

Validates `landing_state` against the closed set `{"ready", "human_review", "done", "abandoned"}`; raises `ValueError` otherwise. Writes a 60-column-wide ASCII banner to `sys.stdout` (via plain `print()`). Internal table maps each state to (owner, explanation line, list of next-move tuples). Terminal states (`done`, `abandoned`) print "Terminal state. No further action." instead of a next-moves block.

The function is the *only* place that knows the banner format. Call sites pass only `landing_state` and `run_id`.

### 2. Banner shape (60 columns)

```
============================================================
STOP. State: <landing_state> (<owner>-owned).
<one-line explanation>.

Next moves (<owner>-triggered):
  agent-workbench <cmd> <run_id>  - <description>
  ...
============================================================
```

Per-state copy:

- `ready`: owner=`human`, explanation=`The plan is staged and waiting for human approval`, next moves=`agent-workbench start <run_id>  - approve the plan and create the worktree`.
- `human_review`: owner=`human`, explanation=`The run is staged for human review and decision`, next moves=`agent-workbench complete <run_id>  - accept and merge`, `agent-workbench bounce <run_id>    - send back to building`, `agent-workbench abandon <run_id>   - abandon the run`.
- `done`: owner=`no one`, terminal block reads `Terminal state. The run is accepted and merged.`; no next moves.
- `abandoned`: owner=`no one`, terminal block reads `Terminal state. The run is abandoned.`; no next moves.

### 3. Wiring

Each of the five `cmd_*.py` files gets one new line:

```python
from lib.cli._stop_banner import print_stop_banner
…
print_stop_banner("<landing_state>", run_id)
return 0
```

Placed immediately before `return 0` on the relevant success path. No other code changes.

### 4. AGENTS.md cross-reference

Insert one paragraph at the top of "How to drive the workbench" (line 39):

> When you see a `STOP.` banner in CLI stdout, your session ends — the run has landed in a state that the agent does not drive (`ready`, `human_review`, or terminal). Do not invoke the listed next commands; those are the human's call.

### 5. Tests

- `tests/test_stop_banner.py`:
  - Unit test per landing state: call `print_stop_banner(state, "test-run-id")` with `contextlib.redirect_stdout(io.StringIO())`, assert output starts with `===…`, contains `STOP. State: <state>`, contains `test-run-id` only for non-terminal states, ends with `===…\n`.
  - Negative test: `print_stop_banner("planning", "x")` raises `ValueError`.
  - Snapshot test per state: read `tests/snapshots/stop_banner_<state>.expected.txt`, assert exact match. Env-guarded re-baseline (`WRITE_SNAPSHOTS=1`).
- `tests/test_e2e.py`:
  - In `TestE2EHappyPath.test_happy_path`: after the `plan` finalize call (~line 167), assert `self.assertIn("STOP.", r.stdout)` and `self.assertIn("State: ready", r.stdout)`. After the `followups` default-mode call (~line 195), assert `STOP.` and `State: human_review`. After the `complete` call (~line 218), assert `STOP.` and `State: done`. Also assert STOP does NOT appear after `shape`, `plan --init`, `start`, or `validate --init`.
  - In `TestE2EAbandon.test_abandon_at_draft` (or any abandon test): assert `STOP.` and `State: abandoned` in `r.stdout`.
- `tests/test_stop_banner.py` (continued):
  - Test that `cmd_complete` does NOT print the banner when the merge aborts on a dirty worktree. Easiest via the existing complete-error fixture pattern (we'll likely reuse the worktree-dirty test if one exists; else add a small focused subprocess test).

## Files likely to change

- `agent-workbench-live/lib/cli/_stop_banner.py` (NEW)
- `agent-workbench-live/lib/cli/cmd_plan.py`
- `agent-workbench-live/lib/cli/cmd_validate.py`
- `agent-workbench-live/lib/cli/cmd_followups.py`
- `agent-workbench-live/lib/cli/cmd_complete.py`
- `agent-workbench-live/lib/cli/cmd_abandon.py`
- `agent-workbench-live/AGENTS.md`
- `agent-workbench-live/tests/test_stop_banner.py` (NEW)
- `agent-workbench-live/tests/test_e2e.py`
- `agent-workbench-live/tests/snapshots/stop_banner_ready.expected.txt` (NEW)
- `agent-workbench-live/tests/snapshots/stop_banner_human_review.expected.txt` (NEW)
- `agent-workbench-live/tests/snapshots/stop_banner_done.expected.txt` (NEW)
- `agent-workbench-live/tests/snapshots/stop_banner_abandoned.expected.txt` (NEW)

## Data model changes

None. No changes to `metadata.yaml`, `events.jsonl`, schemas, or transitions.yaml. Banner is stdout-only.

## UI changes

None (workbench has no UI surface; the board TUI is unaffected since it reads metadata/events, not CLI stdout).

## Test plan

- **Unit tests** (`tests/test_stop_banner.py`):
  - `test_ready_banner_format` — calls helper for `ready`, asserts banner shape, contains run_id, contains `agent-workbench start`.
  - `test_human_review_banner_format` — for `human_review`, asserts the three next-move lines (complete/bounce/abandon).
  - `test_done_banner_format` — for `done`, asserts terminal phrasing and absence of next-move block.
  - `test_abandoned_banner_format` — for `abandoned`, same as done.
  - `test_invalid_state_raises` — `print_stop_banner("planning", "x")` raises `ValueError`.
  - `test_snapshot_per_state` — four snapshot tests, one per state, comparing exact output to `tests/snapshots/stop_banner_*.expected.txt`.
- **E2E tests** (`tests/test_e2e.py` extensions):
  - Happy path: assert STOP banner after `plan` (ready), `followups` (human_review), `complete` (done); assert STOP does NOT appear after `shape`, `plan --init`, `start`, `validate --init`.
  - Abandon path: assert STOP banner after the `abandon` call in at least one abandon test.

## QA plan

- **QA-1.** Run a fresh smoke run via the CLI manually:
  ```
  agent-workbench new-run --repo-path … --worktree-name qa-smoke <<<"# QA banner smoke"
  agent-workbench shape <id> --init && agent-workbench shape <id>
  agent-workbench plan <id> --init && agent-workbench plan <id>     # <-- STOP: ready
  agent-workbench start <id> --approved-by me
  agent-workbench validate <id> --init
  agent-workbench validate <id> --tests-passed true --known-issues 0
  agent-workbench followups <id>                                    # <-- STOP: human_review
  # (make a commit on the worktree)
  agent-workbench complete <id> --accepted-by me                    # <-- STOP: done
  ```
  Confirm visually that the STOP banner is the last block of stdout at the three marked steps and is ABSENT at every other step.
- **QA-2.** Repeat with `agent-workbench abandon <id> --reason "qa" --abandoned-by me` from a fresh draft. Confirm STOP: abandoned banner.
- **QA-3.** Trigger a complete failure (e.g. dirty worktree). Confirm exit code is non-zero AND no STOP banner.

## Risks

- **Snapshot drift.** Banner text is pinned in 4 .expected.txt files; any wording change requires re-baselining. Mitigation: keep banner text minimal and stable.
- **Test fragility around exact CLI output.** Other E2E assertions already match `r.stdout` substrings (e.g. `shaping -> planning`); adding STOP assertions in the same idiom is low-risk.
- **Banner could obscure useful stdout** if a future caller pipes the output. Since the banner is purely additive and at the end, downstream parsers that grep for the existing `<id>: A -> B` line are unaffected.
- **Validation of staged vs flat layout in validate.** The flat-layout path in `cmd_validate.py` exists for legacy runs only; the test fixtures don't currently exercise it. Mitigation: validate wiring by code-reading the branch condition (`if staged: … return 0; … <flat path>`), and confirm the banner sits in the flat branch's success path only.

## Definition of done

- `lib/cli/_stop_banner.py` exists with `print_stop_banner(landing_state, run_id)`, raises `ValueError` on invalid state, prints the four banners.
- All five `cmd_*.py` files import the helper and call it on the right success path.
- `AGENTS.md` has the one-sentence cross-reference.
- `tests/test_stop_banner.py` exists with the seven tests listed in the test plan, all green.
- `tests/test_e2e.py` extended with STOP assertions in happy path + abandon path, all green.
- Four snapshot fixtures exist and match the helper's output.
- Full `agent-workbench-live/tests/` suite passes (modulo the two known pre-existing date-baked snapshot drift failures noted in the LOG).
- `docs/TODO.md` §2 marked complete with merge SHA + LOG.md entry on `complete`.

## Preflight

- **Repo path**: `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai`.
- **Repo name**: `agentic-development-task-system-v3__ai` (the workbench's own repo).
- **Base ref**: `HEAD` (workbench default, the master branch is the parent).
- **Branch name**: `agent/2026-05-24__cli-stop-banner-on-agent-stopping-transitions` (workbench template).
- **Worktree name**: `2026-05-24__cli-stop-banner-on-agent-stopping-transitions`.

**Checks performed:**
- All five target `cmd_*.py` files exist and the success-print line numbers above are correct as of the `master` HEAD shown in the git status (`098c24a docs(TODO): add §2 — CLI stop banner on agent-stopping transitions`).
- `lib/cli/` has no existing `_stop_banner.py`; the new module name doesn't collide.
- `tests/snapshots/` exists and is the standard snapshot location.
- The transition engine takes its target state as a string; there's no enum to keep in sync.
- E2E tests use `subprocess.run(..., capture_output=True, text=True)` so substring assertions on `r.stdout` are the established idiom.

No warnings.

## Decisions & assumptions

### DR-001
- **Decision**: One shared helper module `lib/cli/_stop_banner.py` owns the banner format. Every call site passes only `landing_state` and `run_id`.
- **Rationale**: The brief mandates "one source of truth for the banner format" so wording stays in sync across five call sites. A free-function module is the lightest viable design.
- **Alternatives considered**: (a) Inline the banner string in each `cmd_*.py`. (b) Add a `print_stop_banner` method on the `transitions` module. (c) Make it a method on a `Banner` class.
- **Why not the alternatives**: (a) violates the brief's single-source-of-truth requirement and guarantees wording drift. (b) couples runtime stdout to the transition engine, which is supposed to be policy-neutral; the transition engine doesn't know about CLI-level concerns. (c) needless OOP overhead for one pure function.

### DR-002
- **Decision**: Banner is plain ASCII, fixed at 60 columns, plain `print()` to stdout. No ANSI escapes, no Unicode.
- **Rationale**: Matches existing CLI output style across all `cmd_*.py` files (none of them use color or Unicode). 60-column matches the visual weight of the existing `branch: …` / `worktree: …` / `audit: …` lines and is wide enough for the longest banner line (`agent-workbench complete <run_id>  - accept and merge`, ~58 chars even with a moderate-length run_id).
- **Alternatives considered**: (a) Variable width by terminal size. (b) ANSI color (bold red `STOP`). (c) 80 columns.
- **Why not the alternatives**: (a) tests can't reliably pin variable output; snapshot fragility. (b) color codes don't survive pipes and clutter log captures. (c) longer lines for no readability gain; 60 is enough.

### DR-003
- **Decision**: Banner prints only on the actual success path of each command, after the transition is durably recorded.
- **Rationale**: Brief AC-5 requires that no banner appears on aborted transitions (e.g. merge conflict, dirty worktree). Placing the call immediately before `return 0` on the success branch — after every existing `print` and `metadata.update` — guarantees this.
- **Alternatives considered**: (a) Use an `atexit` hook based on final state. (b) Inject from `transitions.transition(...)` itself. (c) Wrap the whole `run()` function.
- **Why not the alternatives**: (a) `atexit` is global state, fragile under tests, and would fire even on `--init` paths. (b) couples engine to stdout (same as DR-001's rejection of option b). (c) requires intrusive control-flow change for no benefit over the simple in-line call.

### DR-004
- **Decision**: Terminal states (`done`, `abandoned`) omit the "Next moves" block and substitute a "Terminal state." line instead.
- **Rationale**: Brief AC-3 says terminal states have no next moves. Printing an empty `Next moves:` block would be visually noisy and ambiguous.
- **Alternatives considered**: (a) Always print "Next moves" with "  (none)". (b) Print only the closing border for terminals.
- **Why not the alternatives**: (a) misleading — there really are no follow-up commands. (b) the explanation line wouldn't be enough framing on its own.

### DR-005
- **Decision**: Invalid `landing_state` raises `ValueError`. Call sites are internal — defensive validation, not user-facing.
- **Rationale**: Closed-set states; passing anything else is a programming error. ValueError surfaces the bug at call time, in tests.
- **Alternatives considered**: (a) Silently no-op. (b) Print a generic banner. (c) Log a warning and continue.
- **Why not the alternatives**: All three hide bugs. Internal helper APIs should fail loud.

### DR-006
- **Decision**: Wire the banner into `cmd_validate.py` only on the flat-layout `validating -> human_review` path (line 444). The staged path that lands at `followups` (line 399) does NOT print it; the followups stage's transition into `human_review` is where the staged-run banner fires.
- **Rationale**: Brief AC-7 specifies this exactly. The staged path is still agent-driven (the agent owns `followups`), so it's not an agent-stopping transition.
- **Alternatives considered**: (a) Banner on both paths. (b) Banner only on staged path.
- **Why not the alternatives**: (a) would fire a STOP banner on a state the agent IS expected to drive (`followups`), diluting the signal. (b) would leave flat-layout legacy runs without a stop signal.

### DR-007
- **Decision**: One unit-test module `tests/test_stop_banner.py` covers both the helper's behavior and the four snapshot fixtures. The E2E test extension lives in `tests/test_e2e.py`'s existing classes.
- **Rationale**: Co-locating banner unit + snapshot tests keeps the change discoverable; extending the existing E2E class is consistent with how previous TODO sections have layered tests onto the happy-path scaffold.
- **Alternatives considered**: (a) Split snapshots into their own file. (b) Add new E2E class for banner.
- **Why not the alternatives**: (a) marginal benefit; the snapshot tests are tiny and tightly coupled to the unit tests. (b) the happy-path E2E already drives every relevant transition; a parallel class would duplicate setup.

### DR-008
- **Decision**: AGENTS.md cross-reference is one paragraph inserted at the start of "How to drive the workbench" (between the heading and the existing `Run the CLI:` paragraph), not added to "Two hard rules" or to a new top-level section.
- **Rationale**: Brief AC-11 calls for "one sentence" under "How to drive the workbench". Inserting it where the agent is told how to read CLI output is the right contextual home; adding a new hard rule would over-elevate a nudge.
- **Alternatives considered**: (a) Add to "Two hard rules" as rule #3. (b) Add to "When you get stuck". (c) New top-level section.
- **Why not the alternatives**: (a) the banner is a nudge, not a hard rule (per design principle "convention over enforcement"). (b) the banner is not a stuck-state recovery mechanism. (c) over-structures for a one-sentence cross-reference.

### ASM-001
- **Text**: All five `cmd_*.py` success paths are reachable in isolation; placing the banner call between the last `print` and `return 0` does not change exit codes or side effects.
- **Reason**: Confirmed by reading each command's source. Each path is a linear sequence of prints + metadata.update + best-effort metrics + return.
- **Impact**: low.

### ASM-002
- **Text**: The E2E test harness's `subprocess.run(..., capture_output=True)` captures all stdout produced by the CLI subprocess, including the new banner lines.
- **Reason**: Standard subprocess behavior; the existing test assertions on `r.stdout` for `shaping -> planning`, `validating -> followups`, `human_review -> done`, etc. already prove this works.
- **Impact**: low.

### ASM-003
- **Text**: The `lib.cli._stop_banner` module can be imported from each `cmd_*.py` without circular imports because the helper has no dependencies on other `cmd_*.py` modules nor on `lib.transitions` / `lib.metadata`.
- **Reason**: The helper only needs `sys` (or just `print`) plus an internal data structure. No transitive imports back into the CLI dispatcher.
- **Impact**: low.

### ASM-004
- **Text**: `validate --init` (line 273 in `cmd_validate.py`) lands the run at `validating`, not `human_review` or `followups`. Adding the banner to the default mode only — not to `--init` — is therefore correct.
- **Reason**: The transition target on line 248 is literally `"validating"`.
- **Impact**: low.

### ASM-005
- **Text**: `cmd_plan.py`'s `--init` path (line 154) lands the run at `shaping` (still in shaping). Wait — actually re-reading: `--init` requires status=planning and stages templates; the print at line 153 is the `staged {templates}` message, no state change beyond what `shape`'s default mode already did. The banner is correctly tied only to the final-plan path that lands at `ready` (line 264).
- **Reason**: Re-confirmed by reading lines 123-154 vs 156-264 of `cmd_plan.py`.
- **Impact**: low.

### ASM-006
- **Text**: The two pre-existing date-baked snapshot drift failures on master (mentioned in the most recent LOG entries) will not be re-baselined by this run; the test plan only adds NEW assertions and NEW snapshot fixtures.
- **Reason**: This is a workbench convention reaffirmed by the auto-merge-on-complete run's LOG; we only own banner-related tests.
- **Impact**: low.

### ASM-007
- **Text**: The order of stdout lines in `cmd_validate.py`'s flat-layout path (`validating -> human_review`, `branch:`, `worktree:`, `audit:`) does not need to change; the banner goes AFTER all four existing lines.
- **Reason**: Brief: "Banner is purely additive. The existing transition line and any artifact-path line still print first, in their existing order."
- **Impact**: low.

### ASM-008
- **Text**: A merge-conflict failure path in `cmd_complete.py` already exits via `return fail(str(e), e.exit_code)` (line 119) BEFORE reaching the success print at line 137. The banner call placed after line 140 is therefore guaranteed not to fire on conflict.
- **Reason**: Code-read confirmation. The `_CompleteError` raise inside `_do_merge` is caught at line 118 and turned into a `fail(...)` return.
- **Impact**: low.
