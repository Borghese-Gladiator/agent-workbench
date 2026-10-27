# Follow-ups

---
title: Dedupe timeline rows that project from semantically identical events
motivation: When `cmd_start` runs, both the `TransitionApplied: ready → building` event and the `WorktreeCreated` event project to a "worktree at … on …" row at the same timestamp. The current renderer emits both. Cosmetic, but it makes the timeline noisier than it needs to be.
suggested_scope: One unit test asserting the desired dedup; one branch in `lib/human_review.project_timeline` that collapses adjacent rows with the same `(stage, hhmmss)` and a Jaccard-similar description.
category: refactor
---

---
title: Surface Documentation-touched verification in `## Manual testing performed`
motivation: The renderer already pulls `DocClaimsVerified` events into the testing block, but the `DocClaimsVerified.payload.unverified` list isn't itemised — only the count appears. When unverified > 0, the reviewer has to open `review.md` to see which paths are wrong.
suggested_scope: Render each unverified path as a sub-bullet under "Documentation claims → N unverified". One unit test.
category: scope_extension
---

---
title: Add a `## Token efficiency` block once TODO §2 (token tracking) lands
motivation: TODO §2 of the renumbered TODO (formerly §3) explicitly lists "HUMAN_REVIEW integration" as one of its tasks. The renderer should grow a small section that reads `runs/<id>/metrics.jsonl` (when present) and emits one line per metric + a one-line cost summary.
suggested_scope: Two changes in `lib/human_review.py`: (1) a `_token_efficiency_block(rd)` helper that returns `None` when no `metrics.jsonl` exists, and (2) a conditional `## Token efficiency` heading whose body is the helper's output. Update `REQUIRED_HUMAN_REVIEW_HEADINGS` only if we decide the section is mandatory once metrics exist.
category: scope_extension
---

---
title: Tighten the snapshot normalizer's `<TMP>` regex
motivation: The current `_normalize` in `tests/test_human_review.py` uses `(/private)?/var/folders/[A-Za-z0-9_/]+/aw-[A-Za-z0-9_-]+`. The first character class allows `_/`, which means a `/var/folders/.../aw-..._...` path could over-match if the tmp dir ever embeds an `aw-` segment inside its random suffix. Today it doesn't, but the regex is wider than it needs to be.
suggested_scope: Replace the `[A-Za-z0-9_/]+` with `[^/]+(/[^/]+)*?` non-greedy and lock the match to end at a `/` boundary. One regression test that feeds the normalizer a path with a nested `aw-` segment.
category: tech_debt
---
