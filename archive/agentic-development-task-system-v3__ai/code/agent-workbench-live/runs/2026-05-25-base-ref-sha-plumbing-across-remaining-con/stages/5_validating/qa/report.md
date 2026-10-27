# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 2 (both pre-existing, documented below)

## What ran

- Full unit-test suite (`tests/`) — 337 tests collected, 335 passed, 2 failed (pre-existing date-wraparound).
- Focused re-runs on each module touched by this change.
- Python import smoke for every touched module.
- The new backfill script in both `--dry-run` and write modes against the live workbench.
- `agent-workbench metrics --rebuild` against one successfully-backfilled run.

No browser, Playwright, or QA recordings — this run is internal library plumbing with no UI surface.

## Results

### Unit tests

Focused suites (all new tests added by this run pass; all pre-existing tests in touched modules still pass):

| Suite | Result | New tests added |
|---|---|---|
| `tests/test_validate_context_build.py` | 12 passed | 3 (TestPrefersBaseRefSha) — F-008 tightened fallback test |
| `tests/test_doc_claims.py` | 4 passed | 2 (prefer-SHA + fallback) |
| `tests/test_board_snapshot.py` | passed (incl. new `TestGitShortstatPrefersSha` × 3) | 3 |
| `tests/test_backfill_base_ref_sha.py` | 5 passed | 5 (new file) |
| `tests/test_self_modifying.py` | 2 passed | 1 (TestSelfModifyingBaseRefResolvedEvent) — added per F-003 |
| `tests/test_e2e.py::TestE2EHappyPath` | 1 passed | 0 (extended existing `test_happy_path` with BaseRefResolved + audit.md assertions) |

Full suite (`tests/`): **335 passed, 2 failed**. Failed: `tests/test_human_review.py::TestSnapshotRender::test_happy_snapshot`, `tests/test_human_review.py::TestSnapshotRender::test_bounce_pass2_snapshot` — see Known issues.

### Integration tests

Covered by the E2E suite (`test_e2e.py`) and the self-modifying suite (`test_self_modifying.py`). Both pass.

### Lint / typecheck

Not run separately — no linter is configured for the workbench (Python stdlib only; no mypy/ruff/black in `tools/` or `bin/`). The Python imports were verified via a smoke check:

```
PYTHONPATH=agent-workbench-live python3 -c "from lib import validate_context, doc_claims, audit; from lib.board import source; from lib.cli import cmd_start, cmd_new_run, cmd_validate; print('import OK')"
```

Result: `import OK` for all touched modules.

### Browser / Playwright

N/A — no UI surface in this change.

### Smoke scripts

The backfill script was driven end-to-end against the live workbench:

- `--dry-run`: reported 1 would-be-changed (`2026-05-22-shogi-core`), 4 already-backfilled, 6 skipped (5 v2-source-repo-missing + 1 non-ASCII-guarded), 5 failed (branch refs gone from old runs). No writes; metadata files byte-identical after.
- Write mode: same totals, wrote `base_ref_sha: 126ab634…` to `runs/2026-05-22-shogi-core/metadata.yaml`. Single-line diff (`+    base_ref_sha: "126ab634…"`). File size 1.5KB (no yaml_io explosion).
- `agent-workbench metrics --rebuild 2026-05-22-shogi-core`: ran without error. `generated_lines: 0` is the correct answer for this run (its fork SHA equals its fingerprint — no real worktree commits past base). The AC 5 mechanism is proved correct by the synthetic-repo unit tests, not this number.

## Captured artifacts

- `qa/commands.txt` — exact commands logged. No recordings or traces (no UI).
- Raw pytest output for the full suite is stored at `~/Library/Application Support/rtk/tee/1779770927_pytest.log` (transient; the test counts above are authoritative).

## Known issues

1. **Pre-existing snapshot date-wraparound** — `tests/test_human_review.py::TestSnapshotRender::test_happy_snapshot` and `::test_bounce_pass2_snapshot`. Snapshots in `tests/snapshots/human_review_{happy,bounce_pass2}.expected.md` embed run-id prefixes like `2026-05-22-happy-snap`; today is 2026-05-26 and `_normalize` (`tests/test_human_review.py:438`) doesn't collapse `YYYY-MM-DD-` segments inside run IDs. Independently verified by running the same tests against an unmodified `master` checkout (same failures). Not introduced by this run; recommended follow-up: extend `_normalize` to collapse run-id date prefixes, or pin a deterministic test date via env-var.

2. **`lib/yaml_io` UTF-8 round-trip corruption** — pre-existing latent bug. `lib/yaml_io.py:187` decodes double-quoted strings via `s.encode().decode("unicode_escape")`, which destroys non-ASCII characters by interpreting their UTF-8 bytes through Latin-1. Each round-trip doubles the corruption. Discovered when an initial backfill pass on `runs/2026-05-22-s2-attrs/metadata.yaml` (already 263KB of mojibake from an earlier round-trip on master) wrote a 525KB file. That backfill was reverted. The new `tools/backfill_base_ref_sha.py` defensively refuses to round-trip non-ASCII metadata; the root cause is unfixed and tracked as a follow-up. The same bug affects `tools/backfill_completion_refs.py` and any other caller of `metadata.update` on records with non-ASCII fields.
