# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 0

## What ran

- `python3 -m unittest discover -s tests` inside the worktree.

## Results

### Unit + integration tests

```
Ran 93 tests in 9.297s
OK
```

All 93 tests pass, including the new assertion that the worktree
basename carries today's `YYYYMMDD__` prefix.

### Manual verification

- Inspected `lib/run_ids.py`: the regex `^(\d{4})-(\d{2})-(\d{2})-`
  matches the run_id format set by `make_run_id`.
- `extract_run_date("2026-05-21-foo")` → `"20260521"` (mentally
  traced).
- The integration test reads `worktree.path` from metadata, so its
  YYYYMMDD assertion is comparing against today's date as observed by
  `_dt.date.today()` in the test process — matches the metadata value
  written ~milliseconds earlier in the same test.

## Captured artifacts

None — purely textual verification.
