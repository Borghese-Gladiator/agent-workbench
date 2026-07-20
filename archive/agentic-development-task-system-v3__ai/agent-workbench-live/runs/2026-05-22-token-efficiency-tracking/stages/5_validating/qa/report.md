# QA report (v2)

## Summary

- **tests_passed**: true
- **known_issues_count**: 0

## What ran

- `python3 -m unittest discover -s tests` — full suite.
- Manual: rendered the new HUMAN_REVIEW.md metrics block via Python repl on this run's metrics.jsonl and visually confirmed:
  - Lead-in says `Acceptance pending — this is what we spent to get to human_review.`
  - `### Token spend` section breaks out each kind on its own bullet with units.
  - `cache_read` explainer paragraph reads cleanly.
  - `### Build progress (not acceptance)` uses `agent-approved validates` / `build → validate cycles` wording.
  - `### Acceptance (gated on human + merge)` shows accepted_lines: 0 _(pending …)_.
  - `### Context buckets (input tokens, post-cache-attribution)` renders as top-level markdown bullets with `tokens` units.

## Results

### Unit tests

```
$ python3 -m unittest discover -s tests
....................................................................................................................................................................................................................................................
----------------------------------------------------------------------
Ran 244 tests in 18.413s

OK
```

244 tests green (was 243; +1 new — `test_single_run_plain_pre_acceptance_warning`).

### Integration tests

Same `test_metrics_writer.py` integration test as v1 still passes — the writer is untouched.

### Lint / typecheck

Not applicable.

### Browser / Playwright

Not applicable.

### Smoke scripts

```
$ bin/agent-workbench doctor
doctor: PASS

$ bin/agent-workbench metrics 2026-05-22-token-efficiency-tracking
# Output now begins with:
#   NOTE: acceptance pending — `accepted_*` and `repair_tokens` only
#   become load-bearing once the run reaches `done` and the branch merges.
# Then the four restructured sections (Token spend / Build progress /
# Acceptance / Context buckets) render in order.
```

## Captured artifacts

None.
