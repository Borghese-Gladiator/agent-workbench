# Follow-ups

---
title: Dedupe timeline rows that project from semantically identical events
motivation: When `cmd_start` runs, both the `TransitionApplied: ready → building` event and the `WorktreeCreated` event project to a "worktree at … on …" row at the same timestamp. The renderer emits both. Cosmetic, but noisier than it needs to be.
suggested_scope: One unit test asserting the desired dedup; one branch in `lib/human_review.project_timeline` that collapses adjacent rows with the same `(stage, hhmmss)` and a similar description.
category: refactor
---

---
title: Surface Documentation-touched verification in `## Manual testing performed`
motivation: The renderer already pulls `DocClaimsVerified` events into the testing block, but the `unverified` list isn't itemised — only the count appears (when non-zero). When unverified > 0, the reviewer has to open `review.md` to see which paths are wrong.
suggested_scope: Render each unverified path as a sub-bullet under "Documentation claims → N unverified". One unit test.
category: scope_extension
---

---
title: Tighten the snapshot normalizer's `<TMP>` regex
motivation: The current `_normalize` in `tests/test_human_review.py` uses `(/private)?/var/folders/[A-Za-z0-9_/]+/aw-[A-Za-z0-9_-]+`. The first character class allows `_/`, so a path could over-match if a tmp dir ever embeds an `aw-` segment inside its random suffix. Today it doesn't, but the regex is wider than it needs to be.
suggested_scope: Replace the `[A-Za-z0-9_/]+` with `[^/]+(/[^/]+)*?` non-greedy and lock the match to end at a `/` boundary. One regression test that feeds the normalizer a path with a nested `aw-` segment.
category: tech_debt
---

---
title: Make `qa/report.md` summary heading configurable
motivation: `_read_report_body` literally matches `## Summary` or `## Results`. A future QA template might use `## TLDR` or `## Outcome`. Today the renderer falls back to "whole file minus title" — usable but verbose.
suggested_scope: Add a constant `QA_REPORT_PREFERRED_HEADINGS = ("Summary", "Results", "TLDR", "Outcome")` in `lib/human_review.py`; iterate that list. One regression test that asserts the `## TLDR` path is recognised.
category: tech_debt
---
