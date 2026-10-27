# Review (v2)

## Decision

approve

## Did the implementation satisfy the brief?

The v1 implementation already satisfied the brief. v2 is a bounce-fix
pass against the presentation layer + one metric-name correction. Every
v1 acceptance-criterion test still passes, and the bounce items each
have a concrete code change and (where applicable) a new test
assertion.

## Did it accidentally expand scope?

No. v2 touched three files:
- `lib/cli/cmd_followups.py` — block authoring
- `lib/cli/cmd_metrics.py` — CLI text output
- `tests/test_cmd_metrics.py` — assertions + one new test

No changes to `lib/metrics/*.py` (the data layer is untouched). No
schema changes. No dataclass field renames — the JSON output remains
backwards-compatible.

## Are there fragile assumptions?

The bounce fix introduces explanatory copy that says cache reads are
"~10× cheaper" than fresh input. That matches current Claude pricing
tiers but will drift if Anthropic changes the multiplier. Risk is low —
the copy is illustrative, not load-bearing on the math (the math
already uses the per-rate values from `prices.yaml`).

## Are there missing tests?

- New section headings asserted in `test_single_run_plain`.
- Pre-acceptance NOTE asserted in `test_single_run_plain_pre_acceptance_warning`.
- The `_inject_metrics_block` helper's markdown output is not directly
  snapshot-tested. It is exercised end-to-end by `cmd_followups` during
  the `followups -> human_review` transition; v2's manual verification
  (re-running the helper in a Python repl on this run's metrics.jsonl
  and reading the produced block) confirmed the format. Snapshot-testing
  the block is a candidate follow-up but was already deferred in v1.

## Are there security / data loss / migration risks?

No. Only authoring changes; no new I/O, no new schema, no new event
types.

## What should the human review first?

1. The regenerated HUMAN_REVIEW.md block (the followups stage will
   re-inject it on the next `agent-workbench followups` call).
   Confirm the lead-in clearly states acceptance is pending.
2. `agent-workbench metrics 2026-05-22-token-efficiency-tracking` (CLI).
   Confirm the section structure matches the markdown block and that
   the `NOTE: acceptance pending` line appears (since status != done).
3. The five bullets in `build.md` § "What changed" map 1:1 to the five
   bounce reasons.

## Blast radius

depth 1 (changed files):
  lib/cli/cmd_followups.py
  lib/cli/cmd_metrics.py
  tests/test_cmd_metrics.py

depth 2 (callers of changed symbols):
  _inject_metrics_block       -> only called from cmd_followups.run (one site).
  _render_summary_plain       -> only called from cmd_metrics.run.

depth 3:
  cmd_followups.run            -> bin/agent-workbench dispatcher
  cmd_metrics.run              -> bin/agent-workbench dispatcher

No depth 2/3 reach outside the metrics CLI / followups path.

## Findings

### F-001
- **Severity**: minor
- **Where**: `lib/cli/cmd_followups.py` _inject_metrics_block
- **Issue**: The block now contains three italicized prose paragraphs (cache_read explainer, bucket-attribution caveat, acceptance-pending note). These are inline Python string literals. If a fourth or fifth explainer gets added, the helper becomes hard to scan.
- **Suggested fix**: When/if the explanatory copy grows further, move it to `templates/HUMAN_REVIEW_metrics_explainer.md` and load. For three short paragraphs the inline literals are fine.

### F-002
- **Severity**: minor
- **Where**: `lib/cli/cmd_metrics.py` _render_summary_plain
- **Issue**: Field-width alignment in the CLI text output uses hardcoded spaces (e.g. `"  total                       "`). If a future label is longer than 28 chars the column will shift.
- **Suggested fix**: Compute max-label width and right-pad. Not blocking.
