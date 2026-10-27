# Build report (v2 — bounce fixes)

This is the second pass after the v1 bounce. The v1 build is archived at
`archive/4_building/build-v1.md` — it captures the original implementation
of the metrics package (still load-bearing). This v2 report documents only
the delta from the bounce feedback.

## What changed

Five fixes addressing the bounce reasons:

1. **Misleading "success" wording.** `tokens / passing build` and
   `attempts / success` read as if they meant human acceptance. They didn't —
   they only counted whether the agent's own `review.md` parsed as `approve`.
   Renamed (in both the HUMAN_REVIEW block and the CLI text output) to
   `tokens / agent-approved validate` and `build → validate cycles`. Added
   prose stating these are agent-side signals only.
2. **`cache_read` 81M unexplained.** The original block crammed all four
   token kinds onto one line. v2 splits them into a `Token spend` section
   with one bullet per kind, each labeled with what it means
   (`input` = fresh this turn, `output` = generated, `cache_read` = re-read
   prefix across N turns, `cache_creation` = first-time write). Added a
   one-paragraph explainer that cache_read dominates long sessions because
   the same prefix is re-shown to the model every turn.
3. **HUMAN_REVIEW lead-in.** Block now opens with
   `_Acceptance pending — this is what we spent to get to human_review._`
   followed by a one-paragraph caveat. The reader can't skim past and
   conclude the run is accepted.
4. **Acceptance separation.** New `Acceptance (gated on human + merge)`
   subsection. `accepted_lines` / `accepted_cost` explicitly marked
   `_(pending — run is in human_review or not yet merged)_` until the merge
   sha is captured. `generated_lines` / `generated_cost` clearly labeled as
   "full run-to-here spend."
5. **Context bucket formatting + units.** Was nested-indent
   `  - other: 1,524`. Now proper markdown bullets `- other: 1,524 tokens`
   with explicit `tokens` units. Same fix in the CLI text output.

Plus a status-aware CLI prefix: when `status != done`, the
`agent-workbench metrics <run-id>` text output now leads with a
`NOTE: acceptance pending` line. The `--json` output is unchanged
(machines don't need the note).

## Files changed

- `lib/cli/cmd_followups.py` — `_inject_metrics_block`. Restructured the
  block into four labeled sections (Token spend / Build progress /
  Acceptance / Context buckets), each with explanatory copy. Bullets are
  now top-level markdown; units present.
- `lib/cli/cmd_metrics.py` — `_render_summary_plain`. Same restructuring
  applied to the CLI text output. Added the status-aware `NOTE` prefix.
- `tests/test_cmd_metrics.py` — updated `test_single_run_plain` to assert
  the four new section headings, the `cache_read` label, and the bucket
  bullet format. Added `test_single_run_plain_pre_acceptance_warning`
  which builds a `status=building` run and asserts the `NOTE: acceptance
  pending` line appears.

## Reviewer reading order

1. `lib/cli/cmd_followups.py:_inject_metrics_block` — read top-to-bottom;
   the new section structure is the contract.
2. `lib/cli/cmd_metrics.py:_render_summary_plain` — verify parity with the
   markdown block (same sections, same labeling, same status-aware note).
3. `tests/test_cmd_metrics.py` — the new assertions encode the bounce
   acceptance criteria.

## Acceptance criteria coverage

| AC (from bounce) | Test or evidence |
|---|---|
| No "success" / "passing build" wording pre-acceptance | `_inject_metrics_block` body: no occurrence of "success" or "passing build"; `test_single_run_plain` asserts the new "agent-approved validates" labeling |
| `cache_read` value comes with an explainer | Block prose `_cache_read dominates long sessions..._`; CLI shows `cache_read (re-read prefix)` label |
| HUMAN_REVIEW lead-in says acceptance pending | First non-heading line of the block is `_Acceptance pending — this is what we spent to get to human_review._` |
| Context buckets render as markdown bullets with units | Block format `- {name}: {N:,} tokens` (no nested indent); CLI same |
| Acceptance section explicitly separates accepted from generated | New `### Acceptance (gated on human + merge)` subsection in block; new `Acceptance (gated on human + merge):` section in CLI |
| Pre-acceptance NOTE in CLI when status != done | `test_single_run_plain_pre_acceptance_warning` |
| All existing tests still pass | 244 tests green (was 243; +1 new) |

## Deviations from plan

None. This was a presentation-layer pass + one metric-semantics rename. No
dataclass field renames (would have broken the `--json` output's
backwards-compat). The underlying `tokens_per_passing_build`,
`attempts_per_success`, etc. fields keep their names in `RunMetricsSummary`
and the JSON output — only the user-facing labels changed.

## Known issues

None.

## Commands run

```
python3 -m unittest discover -s tests      # 244 tests, all green
```

## Documentation touched

none needed — same as v1, this is a presentation tweak with no doc surface
to update.
