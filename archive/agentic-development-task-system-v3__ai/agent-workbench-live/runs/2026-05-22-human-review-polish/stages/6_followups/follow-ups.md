# Follow-ups

---
title: Dedupe timeline rows that project from semantically identical events
motivation: When `cmd_start` runs, both the `TransitionApplied: ready → building` event and the `WorktreeCreated` event project to a "worktree at … on …" row at the same timestamp. The renderer emits both. Cosmetic, but noisier than it needs to be.
suggested_scope: One unit test asserting the desired dedup; one branch in `lib/human_review.project_timeline` that collapses adjacent rows with the same `(stage, hhmmss)` and a similar description.
category: refactor
---

---
title: Surface DocClaimsVerified unverified-list in `## Testing > Manual testing`
motivation: When `DocClaimsVerified.payload.unverified` is non-empty, the renderer drops a single "Documentation claims → N unverified" line in the old `_testing_block`. After CR-007's restructure, that line lives in the wrong sub-section conceptually — it's an automated verification, not unit tests, not manual. It also doesn't itemise which paths are unverified; the reviewer still has to open `review.md` to see them.
suggested_scope: Either (a) thread a third `**Automated verifications**` sub-section under `## Testing` that carries doc claims + scope creep, or (b) surface unverified paths as nested bullets where they already render.
category: refactor
---

---
title: Make `qa/report.md` Summary heading configurable
motivation: `_read_report_body` literally matches `## Summary` or `## Results`. A future QA template might use `## TLDR` or `## Outcome`. Today the renderer falls back to "whole file minus title" — usable but verbose.
suggested_scope: Add a constant `QA_REPORT_PREFERRED_HEADINGS = ("Summary", "Results", "TLDR", "Outcome")` in `lib/human_review.py`; iterate that list. One regression test that asserts the `## TLDR` path is recognised.
category: tech_debt
---

---
title: Lock in the qa-template "## Manual testing" section as a hard expectation
motivation: Pass 3 surfaced that we'd been skipping the manual-testing section that `templates/qa/report.md` defines. The renderer now consumes the section but the upstream contract (i.e. /validate should fail if the section is missing) is still soft.
suggested_scope: Add a /validate-time check that `qa/report.md` contains a `## Manual testing` section (case-sensitive heading match); soft-warn on stdout if absent rather than block. Promote to a block check in a later pass once the discipline is established.
category: scope_extension
---
