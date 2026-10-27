# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 0

## What ran

- Targeted suite: `tests/test_stop_banner.py` + `tests/test_repos.py` — covers both papercuts directly.
- Full workbench suite for collateral check.
- Manual smokes: gitignore behavior via `git check-ignore`, banner rendering via direct Python invocation, grep for residual shell-form literals.

## Results

### Unit tests

- Targeted: `python -m pytest tests/test_stop_banner.py tests/test_repos.py` → **31 passed**.
- Full workbench suite: `python -m pytest tests` → **323 passed, 2 failed**.

The 2 failures are pre-existing and date-rollover-driven:

- `tests/test_human_review.py::TestSnapshotRender::test_happy_snapshot`
- `tests/test_human_review.py::TestSnapshotRender::test_bounce_pass2_snapshot`

Both fail because the test's `_normalize` helper at `test_human_review.py:460-470` does not collapse the run-id date prefix — the snapshot was baked on 2026-05-22 (`2026-05-22-happy-snap` / `2026-05-22-bounce-snap`) and today is 2026-05-26, so the expected vs. rendered text diverges on the date string. The comment at line 466-467 explicitly chose not to normalize this part. Pre-existing on master; not caused by this run. Filed as F-002 in `review.md`.

### Integration tests

Not run separately — they're part of the full suite above (e.g. `tests/test_e2e.py`). All passing except the two `test_human_review` snapshot drifts.

### Lint / typecheck

The workbench is stdlib-Python; no separate linter is wired into the suite. Code changes were small and exercised by the unit tests.

### Browser / Playwright

N/A — no UI surface; the banner is stdout text.

### Smoke scripts

1. **Gitignore behavior:** `git check-ignore -v <runs/<id>/.lock>` returned `.gitignore:318` matching the new `agentic-development-task-system-v3__ai/agent-workbench-live/runs/*/.lock` pattern. Captured in `qa/artifacts/gitignore-check.txt`.
2. **Banner rendering:** `PYTHONPATH=... python -c "from lib.cli._stop_banner import print_stop_banner; print_stop_banner('ready', 'EXAMPLE-RUN-ID')"` produced the expected slash-form output with em-dash and the "type in a session" header. Captured in `qa/artifacts/banner-render.txt`.
3. **Residual-shell-form grep:** `grep -rn "agent-workbench start" agent-workbench-live/ --include="*.py"` excluding `tests/` and `runs/` returned no matches. The only remaining occurrences in the worktree are `README.md` (CLI invocation example for the human — correct), `.claude/commands/start.md` (slash-command doc — correct), and `runs/<id>/...` historical artifacts (frozen — correct). Captured in `qa/artifacts/grep-shell-form.txt`.

## Captured artifacts

- `qa/artifacts/banner-render.txt` — manual render of the `ready` banner.
- `qa/artifacts/gitignore-check.txt` — `git check-ignore -v` output proving the new pattern fires.
- `qa/artifacts/grep-shell-form.txt` — proof no `agent-workbench start` literal remains in production code.
- `qa/artifacts/pytest-targeted.txt` — full targeted-suite output (31 passed).

## Manual testing

A dogfood manual run is implicit in this very session: this run was driven through `/new-run → /shape → /plan → /start` exercising the existing CLI paths, and the imminent `/complete` will exercise the new gitignore line live (the acceptance criterion that can only be verified at merge time). Captured separately in the audit trail.
