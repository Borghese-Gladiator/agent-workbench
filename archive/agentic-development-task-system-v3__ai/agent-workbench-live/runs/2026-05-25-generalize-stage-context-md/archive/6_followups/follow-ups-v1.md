---
title: Build plan-context.md (TODO §1 item 2)
motivation: This run landed build-context.md as the highest-leverage piece. The next sibling in the TODO §1 sequence is plan-context.md, which the planner reads at /plan-stage entry. Will require some new code beyond what build-context needed: detecting repo languages and surfacing build/test commands from agent-workbench.yaml policies, plus a lightweight inline repo map. Now is the right time while the structural pattern is fresh.
suggested_scope: Mirror build-context.md's shape (lib/plan_context.py + tests/test_plan_context.py + cmd_plan.py wiring + docs/lifecycle.md row + AGENTS.md bullet). Include full brief.md, detected languages, build/test commands from policies, brief's "Files likely to change" inlined, plan.md template skeleton, rules reminder. Defer plan_context's repo-map work to a deterministic top-level-dirs + file-extension count; don't try to build a full call graph.
category: scope_extension
---

The repo-map piece is the only meaningful divergence from build-context's shape. Worth keeping it deterministic and shallow rather than reaching for tree-sitter or similar.

---
title: Build followups-context.md (TODO §1 item 3)
motivation: Third sibling in TODO §1. Likely the thinnest of the four — most of what it needs (brief Non-goals, plan Risks, review Decision + findings, QA Known issues, build Deviations) is already in staged artifacts. Mostly a filter + headline rollup.
suggested_scope: lib/followups_context.py + tests + cmd_validate.py wiring (write at the validating → followups boundary, mirroring how build-context writes at ready → building) + docs/lifecycle.md row. Keep the builder small; rely on _section helpers duplicated from validate_context per DR-003 in this run's plan.
category: scope_extension
---

After this lands, three of four siblings exist. At that point a small refactor to extract _read / _section / _HEADING_RE into a shared lib/markdown_sections.py becomes worth doing — but only with three concrete callers in view, not two.

---
title: Wrap inlined build.md template skeleton in build-context.md to reduce heading-hierarchy noise
motivation: F-002 in this run's review.md. The template's own ## headings render as siblings to build-context.md's outer ## sections in markdown viewers. Not blocking, but a 5-line fix to wrap the inlined content in a fenced ```markdown block or HR-bounded region would improve human readability without changing agent behavior.
suggested_scope: Single small edit to lib/build_context.py's build() function (wrap the template inline in ```markdown ... ```), plus update test_build_context.py::test_template_inlined to assert the fence is present. Optionally update plan_context.md and followups_context.md to use the same wrapping convention if those builders inline templates.
category: refactor
---

---
title: Add staged-layout E2E coverage for build-context.md
motivation: The two integration tests in test_build_context.py exercise the flat-layout branch of cmd_start._write_build_context_artifacts. The staged-vs-flat branch (cmd_start.py:138-145) is structurally simple and exercised by manual smoke, but not by an automated test. Adding `self.assertTrue((run_dir / "stages/4_building/build-context.md").exists())` to test_e2e.py::TestE2EHappyPath::test_happy_path after the /start step would close the gap.
suggested_scope: One assertion added to the existing happy-path E2E test. No new fixtures, no new test classes. If the staged path turns out to be buggy under E2E (unlikely given the manual smoke worked), the assertion would expose it.
category: bug_risk
---

---
title: Plumb base_ref_sha through validate_context.py (TODO §3 item 2a)
motivation: This run's own validate-context.md shows an empty ## Final diff because base_ref="HEAD" causes `git diff HEAD...HEAD` to be empty. F-003 in this run's review.md flagged it. Not introduced by this change — pre-existing TODO §3 work — but the reviewer impact is now visible (a curated context with no diff is a degraded review experience). Worth elevating priority.
motivation_followup: This run's own review had to manually compute the diff via `git diff master --stat` because the curated context was empty.
suggested_scope: Per existing TODO §3 item 2a: add base_ref_sha kwarg to validate_context.build and build_blast_radius; thread through cmd_validate.py:_write_validate_context_artifacts; mirror lib/metrics/lines.py:_effective_ref's lazy-fallback chain. Unit test against a synthetic two-commit worktree. No backfill needed for this run (one-time blast-radius hole is acceptable; future runs benefit).
category: bug_risk
---
