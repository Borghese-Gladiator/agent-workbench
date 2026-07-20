"""Per-run token + cost + acceptance tracking.

Measurement only. No budgets, no thresholds, no warnings.

Submodules:
  transcript  -- locate + correlate Claude Code transcripts to a run.
  buckets     -- attribute input tokens to context buckets.
  prices      -- load metrics/prices.yaml; cost computation.
  lines       -- generated_lines + accepted_lines from worktree diffs.
  writer      -- record_run_metrics(cfg, run_id) -> Path; writes metrics.jsonl.
  summary     -- read metrics.jsonl, derive the 8 metrics.
  rollup      -- workbench-wide rollup -> metrics/index.json.
"""
