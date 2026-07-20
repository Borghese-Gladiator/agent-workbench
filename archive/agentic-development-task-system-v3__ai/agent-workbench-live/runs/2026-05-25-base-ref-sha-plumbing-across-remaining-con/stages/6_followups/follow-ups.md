---
title: Fix `lib/yaml_io._parse_scalar` UTF-8 double-quoted-string corruption
motivation: Latent bug in `lib/yaml_io.py:187` — `s.encode().decode("unicode_escape")` shreds non-ASCII characters by routing UTF-8 bytes through Latin-1. Each round-trip doubles the corruption. Discovered when an initial backfill pass on `runs/2026-05-22-s2-attrs/metadata.yaml` (already 263KB of mojibake from a prior round-trip on master) wrote a 525KB file. The pre-existing 263KB came from at least one earlier round-trip on master, so any tool calling `metadata.update` on records with non-ASCII fields silently corrupts data. `tools/backfill_completion_refs.py` is at risk; `tools/backfill_base_ref_sha.py` defensively guards against it but the root cause is unfixed.
suggested_scope: Replace the `encode().decode("unicode_escape")` line in `lib/yaml_io._parse_scalar` with a real YAML escape table (`\n`, `\t`, `\\`, `\"`, `\xHH`, `\uHHHH` only). Add tests for: em-dash, smart quote, Japanese character, emoji. Re-run any existing backfill scripts in a dry-run pass to surface latent corruption that the fix may now read correctly. Out of scope: a full YAML spec compliance pass — keep the subset.
category: bug_risk
---

Concrete reproduction:

```
python3 -c "s='Dogfood—test'; print(repr(s.encode().decode('unicode_escape')))"
# -> 'Dogfoodâ\x80\x94test'
```

`s2-attrs/metadata.yaml` and any other run-metadata authored with non-ASCII scope.summary or brief paths is currently a corruption time bomb.

---
title: Make `test_human_review.py` snapshot tests date-stable
motivation: `tests/test_human_review.py::TestSnapshotRender::{test_happy_snapshot,test_bounce_pass2_snapshot}` fail on every machine where today's date != 2026-05-22 (the snapshot baseline). The `_normalize` helper at `test_human_review.py:438` collapses tmp paths and timestamps but not the `YYYY-MM-DD-` prefix in run IDs. Two failures show up in every full-suite run today (verified against master). Hides real regressions because reviewers learn to ignore the snapshot diff.
suggested_scope: Either (a) extend `_normalize` to substitute a fixed `<DATE>` placeholder for `YYYY-MM-DD-` prefixes inside run-id contexts and re-baseline the two snapshots, or (b) inject a deterministic test-mode date via env-var (e.g. `AGENT_WORKBENCH_FREEZE_DATE`) consumed by `lib/run_ids.make_run_id`, set it in the snapshot tests' `setUp`. (a) is smaller; (b) is more honest but requires touching production code.
category: tech_debt
---

---
title: Promote `_effective_ref` to a shared helper
motivation: After this run, three copies of the prefer-SHA / lazy-resolve pattern exist: `lib/metrics/lines.py:_effective_ref`, `lib/validate_context.py:_effective_ref`, and inline two-line versions in `lib/doc_claims.py:verify` + `lib/board/source.py:_git_shortstat`. DR-001 in the plan deferred the abstraction at the second-copy moment ("the third copy is the right time to extract, not the second"). The third copy now exists. Future consumers (TODO §7's pre-PR adversarial subagent, any new git-diff caller) should not have to choose between duplicating and importing from `metrics`.
suggested_scope: Add `lib/refs.py:effective_ref(worktree_path, base_ref, base_ref_sha) -> str` with the lazy-resolve fallback. Update the four existing call sites to import from there. Drop the local helpers. One-day refactor; no behavior change. Tests already cover the contract.
category: refactor
---

---
title: Recover v2 source repo or relax AC 5 of the original brief
motivation: AC 5 of the base_ref_sha run named `2026-05-22-token-efficiency-tracking` as the dogfood target — the only run whose `metrics --rebuild` should produce a non-zero `generated_lines` after backfill. Its `target.repo.path` points to a v2 LOCAL_worktrees path (`/Users/timothy.shee/GitHub/LOCAL_worktrees/202605_agent_workbench_v2/agentic-development-task-system-v2__ai`) that no longer exists on this machine. The backfill correctly skips it. Mechanism is independently proven via synthetic-repo unit tests, but the named criterion is environmentally blocked. Either the v2 repo should be re-cloned to verify the live number, or future briefs should not name specific historical runs as acceptance targets (use synthetic fixtures or a "any one pre-fix run" wording).
suggested_scope: Investigate whether the v2 source repo is recoverable (gh archive, local backups, or its remote). If recoverable, clone to the original path and re-run `tools/backfill_base_ref_sha.py --root agent-workbench-live` to verify `2026-05-22-token-efficiency-tracking` actually backfills and `metrics --rebuild` returns non-zero. If not recoverable, open a small docs-only follow-up to revise the brief convention. Either way, document the policy: AC numerics that depend on living external state are environmental risks.
category: deferred_from_bounce
---

---
title: `tools/backfill_base_ref_sha.py` should write `BaseRefResolved` retroactively in a separate "audit-backfill" mode
motivation: AC 9 of this run explicitly forbade synthesizing `BaseRefResolved` events into old `events.jsonl` files — forward-only. That's the right default. But it means there's no audit-log evidence of the resolution for backfilled runs, so future tooling that re-derives metrics from the audit log alone has a blind spot for any pre-fix run. A separate, opt-in flag (e.g. `--write-audit-event`) would let an operator who *wants* the audit-log to be re-derivable accept the slight historical-revisionism cost.
suggested_scope: Add `--write-audit-event` to `tools/backfill_base_ref_sha.py`. When set, emit a `BaseRefResolved` event for each backfilled run via `events.append`, with an additional `payload.backfilled_at` timestamp and `payload.backfill_source: "tools/backfill_base_ref_sha.py"` so future readers can distinguish original from synthesized. Off by default (preserves AC 9 default behavior). Tests for both modes.
category: scope_extension
---
