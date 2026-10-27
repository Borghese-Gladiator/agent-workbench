# Follow-ups

---
title: backfill base_ref_sha for pre-existing runs
motivation: After this fix lands, new runs report `generated_lines` correctly. Pre-existing runs whose `base_ref` is the literal `"HEAD"` (e.g. `2026-05-22-token-efficiency-tracking`, this very run) still report 0 — the lazy resolver inside the worktree can't recover the original fork point once the worktree's HEAD has advanced (R-2 in plan.md). The pass-1 dogfood acceptance criterion in TODO §3 specifically asks for that run to report non-zero. The brief listed it as best-effort and excluded a one-shot script from the in-scope plan; this follow-up promotes it.
suggested_scope: `tools/backfill_base_ref_sha.py` walks `runs/*/metadata.yaml`. For each entry with `target.repo.base_ref` symbolic (e.g. "HEAD", "main") and missing `target.repo.base_ref_sha`, compute the fork point — preferred: `git merge-base <target.worktree.branch_name> <agent-workbench-yaml-defaults.base_ref-symbolic-against-source-repo>`. Fall back to `git rev-list --max-parents=0 <branch>` for runs where merge-base fails. Write the resolved SHA back to `metadata.yaml` via `metadata.update`. Print a per-run before/after diff. Add a `--dry-run` flag. Cap scope at this one tool + tests; no schema changes (this fix's schema is already what we need).
category: scope_extension
---

The lazy-resolver path already gates on `if base_ref_sha:`, so once metadata is backfilled, the existing pass-1 dogfood run will report the right number on the next `agent-workbench metrics --rebuild`. This is the cleanest way to satisfy TODO §3's dogfood acceptance criterion without changing any code in `lib/`.

---
title: emit BaseRefResolved event at /start
motivation: The captured SHA only lives in `metadata.yaml`. The audit log (`events.jsonl`) records the transition with `base_ref: "HEAD"` (symbolic) but not the resolved SHA. Two future use cases would want the SHA in the audit log: (1) re-deriving line counts from the audit trail alone (without re-reading metadata), and (2) detecting drift if `metadata.yaml` is later edited. Today the audit log is incomplete.
suggested_scope: Add a new event type `BaseRefResolved` with payload `{symbolic_ref, sha, source_repo_path}`. Emit it from `cmd_start.py` right after `repos.resolve_ref_to_sha` succeeds, before the `building` transition. Update `lib/audit.py` to surface the resolved SHA in `audit.md`. ~50 lines + an `events.jsonl` schema entry. No metadata changes; no lifecycle changes.
category: tech_debt
---

Pairs naturally with the backfill tool above: the backfill writes the SHA to `metadata.yaml`, but synthetic-`BaseRefResolved` events for old runs would be invented-from-thin-air and out of scope. The event is forward-only.

---
title: extend the symbolic-ref fix to lib/board/source.py and lib/doc_claims.py
motivation: This run's plan explicitly out-scoped `lib/board/source.py:_git_shortstat` and `lib/doc_claims.py:_verify` because their `<base_ref>...HEAD` triple-dot diffs produce a real answer when `base_ref="HEAD"` (worktree-HEAD vs. worktree-HEAD with intermediate commits). But the symmetry is wrong: those consumers also conceptually want the fork point. With this run's `base_ref_sha` field landed, threading it through to those two consumers is a 10-line change each, and tightens the model. Not urgent — none of them are broken today — but the type signature has drifted (lines.py knows about base_ref_sha; the other two don't).
suggested_scope: Add the `base_ref_sha` kwarg to `_git_shortstat` (board) and `verify` (doc_claims). Update the call sites (`board/source.py:566`, `cmd_validate.py` and whichever caller currently passes `base_ref` to `doc_claims`). Mirror the lazy-fallback chain from `lines.py:_effective_ref`. Add two parallel unit tests. Stays within `lib/board/` and `lib/doc_claims.py`.
category: refactor
---

Pure type-symmetry / consistency play. Skip if no one notices the gap.

---
title: schema-level validation for metadata.yaml on load
motivation: `metadata.py:_validate` only enforces top-level keys + the status enum (verified during this run's plan). The richer schema in `schemas/run-metadata.yaml` is descriptive — `metadata.load()` doesn't read it. This made the brief's ASM-002 ("existing metadata.yaml files still validate after the additive field") trivially true, but it also means typos in `metadata.yaml` (mistyped `base_ref` → `bse_ref`, etc.) load silently. As fields proliferate, that drift becomes a real risk.
suggested_scope: Introduce a lightweight YAML-schema validator (or use the existing one in `schemas/`) to walk `target.repo`, `target.worktree`, `validation`, `completion` and enforce field types + enum values on load. Surface as a warning by default, error behind a strict mode (`agent-workbench.yaml`'s policies block). Bounded by `lib/metadata.py` + `schemas/run-metadata.yaml` + a small handful of tests. Don't try to validate `artifacts` / `scope` for this pass.
category: tech_debt
---

Independent of this run's fix but called out by the same plan's ASM-002 — the assumption holds today, but it's load-bearing for every additive schema change. Worth firming up before the next one.
