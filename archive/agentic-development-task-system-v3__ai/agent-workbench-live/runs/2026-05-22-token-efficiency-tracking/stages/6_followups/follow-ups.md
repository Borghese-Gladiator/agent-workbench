# Follow-ups (v2)

The v1 follow-ups are archived at `archive/6_followups/follow-ups-v1.md`. The
items below are the ones still worth pursuing after the v2 bounce fixes.

---
title: Snapshot-test the rendered HUMAN_REVIEW metrics block + CLI text output
motivation: The v2 bounce surfaced presentation-layer issues (misleading names, missing units, bad formatting) that no test caught — the existing tests only assert section headings exist, not that the output reads cleanly. A snapshot test would lock the rendered output and surface a diff on any change.
suggested_scope: Add `tests/test_metrics_render_snapshot.py`. Synthesize a `metrics.jsonl` with known values, call `_inject_metrics_block` on a temp HUMAN_REVIEW.md, snapshot the result. Same for `_render_summary_plain`. ~80 LOC.
category: bug_risk
---

The v2 fixes are correct as authored, but the absence of a snapshot test means a future edit to the explanatory copy could silently regress to v1-style ambiguity.

---
title: Snapshot-test metrics.jsonl against E2E happy and bounce_pass2 fixtures
motivation: Deferred from v1. The brief asked for snapshot-tested metrics outputs from driving the happy/ and bounce_pass2/ E2E fixtures through record_run_metrics. Still warranted to catch transcript-parser drift.
suggested_scope: Same as v1's first follow-up. Author small fixture transcripts under tests/fixtures/e2e/<scenario>/, drive through record_run_metrics, snapshot metrics.jsonl.
category: tech_debt
---

---
title: Auto-detect merge SHA in cmd_complete so accepted_lines populates without --completion-ref
motivation: Deferred from v1. Today the operator must pass --completion-ref <sha> manually for accepted_lines to be non-zero. The natural workflow is: review, merge via gh/git, run complete — at which point we could detect the merge sha automatically.
suggested_scope: Add merge-SHA detection to cmd_complete.py. Walk `git log --merges <base_ref>..<branch>` for the worktree's branch; if found, default completion_ref to that sha.
category: scope_extension
---

---
title: Fix generated_lines for base_ref="HEAD" runs
motivation: When the workbench's default base_ref is the literal string "HEAD" (which it is per agent-workbench.yaml's `base_ref: HEAD`), `git log --numstat <HEAD>..HEAD` is empty and generated_lines reports 0 even for runs that committed multiple files. The line counter needs to use the resolved base SHA captured at /start, not the literal config string.
suggested_scope: At /start time, resolve the base_ref to a SHA via `git rev-parse <base_ref>` and store it in `metadata.target.repo.base_ref_sha`. In lines.py, prefer `base_ref_sha` if present, fall back to `base_ref` for backwards compatibility.
category: bug_risk
---

This v2 run will continue to report `generated_lines: 0` despite having three real commits because of this bug. The fix is small (~20 LOC + a test) but out of scope for the bounce-fix pass.

---
title: HUMAN_REVIEW.md metrics-block position will shift when TODO §2 lands
motivation: Deferred from v1. TODO §2 (Human Review polish) will restructure the "Suggested first checks" and "Run timeline" sections. The metrics block's relative position (currently appended at the end) may need to move closer to the top once §2 finalizes the section ordering.
suggested_scope: Coordinate with TODO §2. Move _inject_metrics_block's append-point from "end of file" to "above ## Run timeline" once §2 lands. Keep the HTML-comment-delimited block format so idempotency is preserved.
category: deferred_from_bounce
---
