# Review

<!--
Bounce-pass 2. First validate pass returned `request_changes` on F-001
(major): cmd_validate.py default mode did not call
_write_followups_context_artifacts() on validating -> followups. The rebuild
(commit 1013789) is scoped to (1) cmd_validate.py: lazy-import + call the
helper after the transition succeeds; (2) cmd_followups.py: docstring update;
(3) tests/test_cmd_validate_followups_handoff.py: new regression test.
-->

## Decision

approve

## Did the implementation satisfy the brief?

Yes, against the worktree code. The change-request asked to close the §5
contract on the canonical validate-default path so the followups stage
agent receives `followups-context.md` regardless of which entry point fires.
The fix at `lib/cli/cmd_validate.py` lines 517-518 inserts the call to
`_write_followups_context_artifacts(cfg, run_id, rd)` immediately after the
`transitions.transition(..., "followups", ...)` block succeeds, before
`metrics_writer.record_run_metrics()`. The placement is correct: the
transition relocates `review.md`, `qa/report.md`, etc. into their
`stages/N_*/` directories, then the helper reads from those locations.

The helper is reused (imported from `cmd_followups`) rather than duplicated.
There remains a single implementation of the followups-context builder
pipeline. AC-bounce-2 satisfied.

## Did it accidentally expand scope?

No. The committed depth-1 file list contains only the three files described
in the build report. The depth-2/3 caller tree in `blast-radius.txt` is
dominated by name-collision noise from very generic helper names
(`_read`, `_section`, `_m`, `_collect_id_blocks`) matching symbols in
unrelated files; those are not real callers of the changed symbols.

## Are there fragile assumptions?

The lazy local-scope import of `_write_followups_context_artifacts` is NOT
wrapped in try/except at the call site. If `lib.cli.cmd_followups` ever
becomes unimportable, the transition will have fired (lines 497-509) but
the master command will crash at line 517 — partial state. The helper's
internal try/except can't catch import-time errors. Filed as F-002 below,
nit severity.

The build report's claim that the local-scope import "avoids a circular at
module load" is not technically accurate: `cmd_followups.py` does not import
`cmd_validate.py` (verified). A module-level import would work. This is a
stylistic call only; not a finding.

## Are there missing tests?

`tests/test_cmd_validate_followups_handoff.py::test_validate_default_mode_writes_followups_context`
correctly pins the F-001 contract:

- Drives the real `cmd_validate.run()` default-mode path (no helper mock).
- Constructs a real git worktree via `git init/add/commit` subprocesses so
  the audit / doc-claim / scope-creep subprocesses don't crash.
- Stages all the prior-stage artifacts the followups-context generator
  lifts from (brief.md Non-goals, plan.md Risks, build.md Deviations,
  review.md Findings, qa/report.md Known issues).
- Asserts on the curated file's existence at the post-transition path
  `stages/6_followups/followups-context.md`, and spot-checks lifted content
  (e.g. "Skip Y.", "Risk A.", "F1.", "I1.", "Dev A.").

The builder also verified the test bites by commenting out the new call —
the AssertionError fired as expected. Good regression discipline.

The test belongs alongside the runtime check the live smoke test was meant
to do (see "Surprises" below).

## Are there security / data loss / migration risks?

None. The change is purely additive: it writes one extra file into the
existing `stages/6_followups/` directory after the transition has already
committed. No schema changes, no migration, no destructive ops.

## What should the human review first?

1. `lib/cli/cmd_validate.py` lines 493-529 — the staged-default-mode block.
   Confirm the call site (lines 517-518) and that it's gated by the
   `if staged:` branch (so flat-layout legacy runs aren't affected).
2. `tests/test_cmd_validate_followups_handoff.py` — confirms the test
   actually drives the production code path.
3. The "Surprises" subsection below — the live smoke test methodology
   is informative for future runs.

## Blast radius

Depth-1 (changed files) is well-scoped: 3 .py files in `lib/cli/`, 3 new
generator modules from the original §5 build, 3 new test files, 3
`.claude/commands/*.md` slash-command bodies, and the run's bookkeeping
artifacts. All within the brief's expected scope.

Depth-2/3 callers in `blast-radius.txt` are dominated by name-collision
noise. The actual callers of the changed symbols are:

- `_write_followups_context_artifacts` -> `cmd_validate.py`,
  `cmd_followups.py` (both expected).
- `_write_plan_context_artifacts`, `_write_shape_context_artifacts` ->
  the respective cmd modules' --init paths only (expected, untouched by
  the rebuild).
- `followups_context._read` etc. -> only test files and other generator
  modules within the same family (expected; DR-003 helper duplication).

No scope-creep risk identified.

## Surprises

Methodology note worth recording: the validate-finalize "live smoke test"
that the instructions called for is NOT an actual test of the fix on a
self-modifying agent-workbench run. The `agent-workbench` CLI dispatches
to the MASTER repo's `lib/cli/cmd_validate.py` (because `--root` defaults
to the master agent-workbench-live), but the fix lives in the WORKTREE's
`lib/cli/cmd_validate.py`. The fix is not in master until the run merges.
So when `agent-workbench validate <run_id>` ran, it used master's OLD
cmd_validate.py (no helper call), and `stages/6_followups/followups-context.md`
was not written — but this is the expected behaviour of a not-yet-merged
fix, not a defect in the rebuild.

Confirmation:

- `grep -n "_write_followups_context_artifacts\|followups_context"
  master/lib/cli/cmd_validate.py` -> no matches.
- The worktree's cmd_validate.py has the fix at lines 517-518.
- The worktree has `lib/followups_context.py`; master does not have it
  yet either, so even a forwarded call would crash on import.
- The regression test against the worktree code passes (56/56 focused;
  444/451 full, with the 7 pre-existing master failures unchanged).

The rebuild is correct. The live smoke test isn't useful for
self-modifying runs prior to merge; the regression test is what actually
validates the fix.

## Findings

### F-001

- **Severity**: closed (was: major in v1)
- **Where**: `lib/cli/cmd_validate.py` lines 517-518 (worktree)
- **Issue**: (closed) The canonical `agent-workbench validate <run_id>`
  default-mode path now writes `followups-context.md` after the
  `validating -> followups` transition. Pinned by
  `tests/test_cmd_validate_followups_handoff.py`. The "live smoke test"
  not landing the file is a methodology artefact (self-modifying run
  before merge), not a defect — see Surprises above.
- **Suggested fix**: n/a — closed.

### F-002 (informational; filed for follow-ups, not a bounce)

- **Severity**: nit
- **Where**: `lib/cli/cmd_validate.py` line 517
- **Issue**: The lazy `from lib.cli.cmd_followups import
  _write_followups_context_artifacts` is not wrapped in try/except. If
  `cmd_followups` ever becomes unimportable, the transition fires
  (lines 497-509) but the master command crashes at line 517, leaving a
  partial state. The helper's internal try/except can't catch
  import-time failures.
- **Suggested fix**: Either (a) move the import to module-level (no
  circular: `cmd_followups` does not import `cmd_validate`), so any
  import failure shows up at startup, or (b) wrap import + call in
  `try: ... except Exception: pass`. Capture as a follow-ups entry; not
  a blocker.
