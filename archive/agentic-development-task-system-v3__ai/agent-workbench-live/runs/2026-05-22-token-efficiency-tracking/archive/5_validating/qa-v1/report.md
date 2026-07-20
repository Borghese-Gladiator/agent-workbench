# QA report

## Summary

- **tests_passed**: true
- **known_issues_count**: 0

## What ran

- `python3 -m unittest discover -s tests` — full unit + integration suite from inside the build worktree.
- `bin/agent-workbench doctor` — schemas + config validation.
- `bin/agent-workbench metrics --rebuild` — workbench rollup regeneration.
- `bin/agent-workbench metrics --all` — rollup print path.

## Results

### Unit tests

```
$ python3 -m unittest discover -s tests
.................................................................................................................................................................................................................................................
----------------------------------------------------------------------
Ran 243 tests in 17.150s

OK
```

Baseline before changes: 193 tests. Added 50 tests across 7 new files:

- `test_metrics_transcript.py` — 10 tests (slugify, find_transcripts, correlate)
- `test_metrics_buckets.py` — 9 tests (per-bucket markers, sum invariant, merge)
- `test_metrics_prices.py` — 9 tests (valid + 4 malformed shapes, warn-once)
- `test_metrics_lines.py` — 11 tests (SHA extraction, generated+accepted)
- `test_metrics_summary.py` — 5 tests (totals, no-approves, repair tokens, cache)
- `test_metrics_writer.py` — 2 tests (integration over synthetic transcript, idempotency)
- `test_cmd_metrics.py` — 4 tests (CLI: plain, JSON, --all, --rebuild)

### Integration tests

`test_metrics_writer.py` synthesizes a Claude Code transcript JSONL with two slash-command turns (`/build` + `/validate`) and three assistant turns, seeds a run's metadata + events.jsonl, monkey-patches `transcript.transcripts_dir()` to redirect the lookup, and calls `record_run_metrics(cfg, run_id)`. Asserts row shape (1 header / 2 turns / 1 build_outcome / 2 line_counts) and idempotency across re-runs.

### Lint / typecheck

Not applicable — this repo doesn't have a lint or typecheck pass configured for the workbench code. The Python is stdlib-only (matches the existing CLI's conventions).

### Browser / Playwright

Not applicable — no UI work.

### Smoke scripts

```
$ bin/agent-workbench doctor
schemas:
  ok       schemas/events.jsonl
  ok       schemas/run-metadata.yaml
  ok       schemas/transitions.yaml
config:
  ok       agent-workbench.yaml (cli=agent-workbench)
doctor: PASS

$ bin/agent-workbench metrics --rebuild
rebuilt: .../agent-workbench-live/metrics/index.json

$ bin/agent-workbench metrics --all
workbench rollup
================
generated_at:        2026-05-22T23:59:35+00:00
runs:                0
validated_runs:      0
first_pass_rate:     n/a (no validated runs)
total_tokens:        0
cost_generated:      $0.0000
cost_accepted:       $0.0000
```

(Zero-runs output because the build worktree's `runs/` is a frozen snapshot of pre-feature runs without metrics.jsonl. The CLI handles the empty case cleanly.)

## Captured artifacts

None. No screenshots, recordings, or traces required for this work.
