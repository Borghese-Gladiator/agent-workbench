---
title: Build plan-context.md (TODO §1 item 2)
motivation: Next sibling in TODO §1. The build-context.md pattern is now battle-tested across two passes (one bounced + rebuilt); the plan-context.md builder is the natural next step. Will require some new code beyond what build-context.md needed — light repo-map (top-level dirs, file-extension counts, detected languages) + surfacing build/test commands from agent-workbench.yaml policies.
suggested_scope: lib/plan_context.py + tests/test_plan_context.py + cmd_plan.py wiring (write at the shaping → planning boundary) + docs/lifecycle.md row + AGENTS.md bullet. Keep the repo-map deterministic and shallow — top-level dirs and file-extension counts, not a call graph. Inline brief's "Files likely to change" so the planner validates or refutes it.
category: scope_extension
---

Now that the build-context.md → validate-context.md cross-stage contract is verified by deterministic E2E tests, the same E2E pattern should extend to plan-context.md: assert it exists after `/plan --init` and contains expected sections.

---
title: Build followups-context.md (TODO §1 item 3)
motivation: Third sibling. Mostly a filter + headline rollup over staged artifacts.
suggested_scope: lib/followups_context.py + tests + cmd_validate.py wiring (write at the validating → followups boundary). Reuse _read / _section helpers duplicated from validate_context.py per DR-003.
category: scope_extension
---

After this lands, three of four siblings exist. Consolidate _read / _section / _HEADING_RE / _collect_id_blocks into a shared `lib/markdown_sections.py` at that point — three concrete callers in view will reveal the right shared API surface.

---
title: Bounce rebuilds should regenerate build-context.md (F-004)
motivation: F-004 in rebuild's review.md. `human_review → building` (bounce) doesn't route through cmd_start.run, so _write_build_context_artifacts is not invoked. The rebuild agent's curated entry was change-request.md instead. The cross-stage contract is consistent for fresh starts but not for bounce rebuilds.
suggested_scope: Two options — (a) cmd_bounce.run calls _write_build_context_artifacts after archiving; (b) extract _write_build_context_artifacts into a public lib.build_context.materialize_for_run that both /start and /bounce call. Option (b) is cleaner and matches DR-002's stance on deterministic write points.
category: refactor
---

---
title: Land TODO §3 items 2b/2c/2d (other base_ref_sha consumers + backfill + audit event)
motivation: This rebuild closed §3 item 2a (validate_context.py). Three more consumers / artifacts remain — board/source.py:_git_shortstat, doc_claims.py:_verify, the backfill tool tools/backfill_base_ref_sha.py, and the BaseRefResolved event in the audit log. Without them, the type signatures across the codebase remain inconsistent and pre-fix runs (like 2026-05-22-token-efficiency-tracking) still report generated_lines: 0.
suggested_scope: Per existing TODO §3 items 2b/2c/2d (no changes to scope — already well-specified). One run to land items 2b + 2c; consider folding 2d into the same run since it's only ~15 lines (schema entry + emission point + audit render).
category: tech_debt
---

---
title: Add E2E coverage for the uncommitted/untracked extension to validate-context.md
motivation: Recorded as untested in QA report. The cross-stage E2E asserts validate-context.md exists, but doesn't assert it carries "Uncommitted" or "Untracked" sections when the test fixture has staged-but-uncommitted edits. The unit tests cover this in isolation; an E2E check would prove the wiring through cmd_validate's helper works end-to-end against a real worktree.
suggested_scope: One additional assertion block in tests/test_e2e.py::TestE2EHappyPath::test_happy_path that stages a synthetic edit in the worktree before /validate --init, then asserts validate-context.md contains "Uncommitted" + the edited filename. Small, deterministic, file-substring-based.
category: tech_debt
---

---
title: Wrap inlined build.md template skeleton in build-context.md (F-002)
motivation: F-002 from pass-1, still open. The template's own ## headings render as siblings to build-context.md's outer ## sections.
suggested_scope: Wrap the inlined template in a fenced ```markdown block in lib/build_context.py's build() function. Update test_build_context.py::test_template_inlined to assert the fence is present.
category: refactor
---
