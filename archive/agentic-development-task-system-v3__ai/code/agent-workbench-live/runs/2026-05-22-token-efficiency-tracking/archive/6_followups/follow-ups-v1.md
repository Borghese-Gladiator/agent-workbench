# Follow-ups

---
title: Snapshot-test metrics.jsonl against E2E happy and bounce_pass2 fixtures
motivation: The brief asked for snapshot-tested metrics outputs from driving the happy/ and bounce_pass2/ E2E fixtures through record_run_metrics. The current pass uses a smaller synthetic-transcript integration test (test_metrics_writer.py) which covers the same code path but doesn't pin the full row layout against realistic data. A snapshot would catch silent drift in the transcript parser, bucketer, or summary aggregation.
suggested_scope: Author small fixture transcript JSONLs alongside the existing tests/fixtures/e2e/happy/ and bounce_pass2/ directories. Wire test_metrics_writer.py (or a new test_metrics_e2e.py) to drive each fixture through record_run_metrics, snapshot the resulting metrics.jsonl, and assert summary metric values. Keep it under ~80 LOC of new test code; the fixture transcripts can be ~10 lines each.
category: tech_debt
---

The synthetic-transcript integration test already verifies the wiring. The deferred work is about catching drift in real transcript shape, not about correctness of the current implementation.

---
title: Capture merge SHA automatically so accepted_lines populates without manual --completion-ref
motivation: Today accepted_lines is 0 until either the operator passes --completion-ref <sha> to `agent-workbench complete` or merges the worktree branch and re-runs complete with the merged sha. The natural workflow is: review HUMAN_REVIEW, merge the branch via gh/git, run `complete`. We don't currently capture the merge SHA at that point because the workbench's local_only policy means it doesn't perform the merge itself.
suggested_scope: Add a helper to `cmd_complete.py` that, when --completion-ref is not passed, attempts to detect a merge commit: walk `git log --merges <base_ref>..<branch>` for the worktree's branch and pick the latest. If found, use that as the completion_ref (still falling back to local-branch:<branch> when no merge exists). Document the new behavior in README §4 and AGENTS.md.
category: scope_extension
---

The plan calls this out (DR-006). A future revision should also consider whether to emit a new "WorktreeMerged" event when this happens — the brief's non-goals deferred that.

---
title: Track the "other" bucket fraction and assert <10% on E2E happy fixture
motivation: Bucket attribution is best-effort. If the heuristic markers in lib/metrics/buckets.py drift (e.g., Claude Code renames "<command-name>" to something else, or CLAUDE.md preambles change), more bytes silently fall into the "other" bucket. We don't currently track the fraction or alert on regression. The brief flagged this as a risk; the mitigation was "track the fraction and assert" but the assert is not wired.
suggested_scope: Add a counter in summary.py that surfaces `bucket_other_fraction = bucket_totals["other"] / total_input`. Surface it in the metrics CLI output. Add a guard in the E2E test that asserts this fraction stays below a threshold (start at 25% — we don't have ground truth yet — and ratchet down as we learn).
category: bug_risk
---

The current implementation honestly reports unattributable bytes, which is the right default. This follow-up is about making heuristic drift detectable rather than silent.

---
title: HUMAN_REVIEW.md metrics-block position will shift when TODO §2 lands
motivation: The "## Token efficiency" block is appended at the end of HUMAN_REVIEW.md, after the "Suggested first checks" and "Run timeline" sections. TODO §2 (Human Review polish) plans to restructure those sections substantially. When §2 lands, the metrics block's relative position may need to move (probably above the run timeline, since it's a quick-scan summary the reviewer wants up top).
suggested_scope: Coordinate with the TODO §2 implementation. Move _inject_metrics_block's append-point from "end of file" to "before ## Run timeline" (or wherever §2 finalizes the section ordering). Keep the HTML-comment-delimited block format so idempotency is preserved.
category: deferred_from_bounce
---

Not deferred from a bounce — this is forward-looking coordination across the two TODO items.
