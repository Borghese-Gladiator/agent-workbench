---
title: Audit-only follow-up to hit the 30% CLAUDE.md/AGENTS.md weight drop
motivation: Pass-2 acceptance #7 targets a 30% combined drop in always-loaded instruction weight. This PR added necessary new normative content (Session discipline, expanded Subagent discipline, Tool-output budget) which dominated the audit savings — net +2.9kB. A purpose-built audit-only run, without simultaneous content additions, can hit the percent. Should also re-examine whether `~/.claude/CLAUDE.md` should be touched (ASM-007 was deliberately not applied — worth revisiting once the operator can see the diff).
suggested_scope: One run, ~half a day. Files: `~/.claude/CLAUDE.md`, repo-root `AGENTS.md`, `agent-workbench-live/AGENTS.md`. Measure character count and token count (via the pass-1 bucketer on a fixed sample) before and after. Target ≥ 30% combined drop. Specifically: identify content (a) duplicated across files, (b) only relevant to a specific stage (move into slash-command bodies), (c) historical reference that doesn't drive behavior (move to docs/architecture.md or docs/LOG.md). LOG.md entry records before/after numbers.
category: tech_debt
---

---
title: Dogfood pass-2 with a fresh validate session, then measure cache_read reduction
motivation: Pass-2 acceptance #9 targets ≥ 40% cache_read reduction on an equivalent-workload run. The structural levers are in place (validate-context.md, blast-radius, fresh-session handoff, subagent discipline), but the actual reduction depends on operator behavior. Without a measurement, "we shipped the levers but didn't measure them" stays open. The `happy/` E2E fixture is not workload-comparable to the 621-turn pass-1 dogfood baseline — a real medium-effort run with the new discipline applied is the only honest comparison.
suggested_scope: One medium-effort run (any unrelated task with ~50–150 turns of building). Drive it with the new Session discipline: fresh session at validate; subagent-first for >3 files; track `largest_session_turns` in the metrics summary. After it lands, re-run `agent-workbench metrics <id>` and compare the cache_read totals + per-bucket attribution against the pass-1 dogfood baseline. Record numbers in LOG.md. If reduction < 40%, identify which lever underperformed and propose a B7-style follow-up.
category: scope_extension
---

---
title: Verify validate-context.md generator against the pass-1 dogfood-style fixture
motivation: The C3 plan called for snapshot tests against the existing `happy/` and `bounce_pass2/` E2E fixtures. Implemented as behavioral tests against tmp-dir fixtures instead, because the existing fixtures don't ship a worktree with real git commits. A purpose-built fixture that includes a worktree with a few commits would let the generator be snapshot-tested byte-for-byte — catching drift the behavioral tests miss (e.g. the order of plan-filter output, the diff stat formatting, the reading-order fallback text).
suggested_scope: One run, ~half a day. Add a new E2E fixture (or extend `happy/`) to include a 2–3-commit worktree under the test-tmp infrastructure. Drive `validate --init` against it. Snapshot the generated `validate-context.md` + `blast-radius.txt`. Wire the snapshots into the existing snapshot harness pattern (`tests/snapshots/`). Catches: drift in the deterministic builder, regressions in the parsers, format changes in the diff-stat output.
category: tech_debt
---

---
title: Production-transcript regression test for the correlator A1 fix
motivation: C2's brief-spec was to load the pass-1 dogfood run's actual transcript and assert > 50% non-`other` stage distribution. Implemented as synthetic tests (which pin the *intent* of the fix but not the *empirical outcome* on the real broken case). ASM-002 said "if transcript missing, test skips gracefully" — that's still the right design. But pinning the actual dogfood outcome would convert ASM-002 from an assumption into a verified result.
suggested_scope: Small follow-up, ~half day. Add `tests/test_metrics_transcript.py::test_dogfood_run_no_longer_all_other` that calls `find_transcripts(slugify_project_path(<dogfood-path>))`. If the file exists locally, run `correlate()`, assert > 50% non-`other` turns. If absent, `pytest.skip(...)`. Document in test docstring that the run is `2026-05-22-token-efficiency-tracking` and the slug depends on the worktree path that was active at dogfood time.
category: bug_risk
---

---
title: Validate-context.md error-path coverage
motivation: review.md F-002 noted that `_write_validate_context_artifacts()` wraps the whole generator flow in `try: ... except Exception: pass`. The intent (convenience artifacts must not break the transition) is correct, but the catch silences any bug in the generator. A bug shipping silently is exactly the failure mode that produces "the file isn't being generated and nobody noticed."
suggested_scope: Small, ~few hours. One test that monkey-patches `validate_context.build` to raise; assert the transition still succeeds AND that the file is NOT written (proving the catch fired). One test that constructs an unparseable build.md and asserts the generator produces a sentinel-fallback file rather than crashing. Optional: log the swallowed exception to events.jsonl so a future audit can find silent failures.
category: tech_debt
---

---
title: Fix auto-merge dirty-check seeing its own `.lock` file
motivation: `agent-workbench complete` acquires `runs/<id>/.lock` via `locks.acquire(cfg, run_id)` BEFORE calling `repos.merge_no_ff`, which then runs `worktree_dirty_files(repo_path)` and sees the lock file as untracked (it's in the runs/ tree that's tracked in the parent repo). The check refuses the merge with "refusing to merge: <repo> has uncommitted changes: ['runs/<id>/.lock']". Hit twice now — the CLI stop-banner run and this pass-2 run both fell back to `--no-merge` + manual `git merge --no-ff`, then `backfill_completion_refs.py` to rewrite `local-branch:` → `merge:<sha>`. The backfill tool's comments (lines 32-37) document the pattern but it's a real bug. Without the fix, every future run that committed its run dir to master before `complete` runs will hit the same wall.
suggested_scope: Small, ~half day. Two options to evaluate: (a) exclude `runs/*/.lock` paths from the dirty-check inside `repos.merge_no_ff` (or in `worktree_dirty_files` with an opt-in filter argument); (b) reorder `cmd_complete` so the dirty-check runs BEFORE `locks.acquire`. Option (a) is robust to future lock-file paths; option (b) is more honest about ordering but risks a TOCTOU window. Add a regression E2E test that runs the full `complete` path with a committed run dir; assert no `.lock`-related refusal. Also update `backfill_completion_refs.py` comments to point at this follow-up's fix.
category: bug_risk
---
