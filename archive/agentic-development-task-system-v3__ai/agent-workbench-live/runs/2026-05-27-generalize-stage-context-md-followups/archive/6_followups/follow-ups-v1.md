# Follow-ups

---
title: Extract _read / _section / _HEADING_RE / _collect_id_blocks into lib/_context_common.py
motivation: With five context-md generators now in the family (build, validate, shape, plan, followups), the helper duplication has stopped being prudent and started being maintenance friction. Any future tweak to `_section()`'s heading-matching behavior has to land in four places (shape doesn't use it). The original duplication rationale ("the two builders may diverge") was sound when there were two; with five, the divergence risk is overstated and the consistency cost is real.
suggested_scope: One run. Add lib/_context_common.py exposing `_read`, `_section`, `_HEADING_RE`, `_collect_id_blocks`. Update all five generators to import. Keep each generator's `_rules_block()` and stage-specific helpers local. Update each generator's module docstring to remove the "duplicated locally" rationale paragraph. Tests: unchanged (the public surface is the same).
category: refactor
---

The §5 run's plan recorded this as DR-003 (keep duplication) plus a "Known issues" note. With shape/plan/followups landed, the cost-benefit has shifted. The reviewer's F-003 finding (nit severity) on the §5 validate flagged it explicitly. Cost of the refactor is small; cost of NOT doing it grows linearly with future generator additions and with each helper tweak.

---
title: Tighten plan_context._detect_repo_map() heuristics or document the trade-offs
motivation: The detection rules are narrow (manifest files only, no recursive scanning), but a few corners aren't covered: monorepos with multiple pyproject.toml files under top-level subdirs (only the root one is checked); package.json scripts whose values contain commas (the script-name extraction regex is permissive); Makefile targets with `:=` assignments vs `:` rules (the current regex matches both, treating an assignment as a target). None of these is dangerous — worst case is one slightly-wrong line in plan-context.md — but the §5 run only validated against the 6 happy-path cases.
suggested_scope: One small run. Add 3–5 edge-case tests to tests/test_plan_context.py covering monorepo subdirs, package.json edge cases, and Makefile assignment-vs-rule disambiguation. Tighten `_MAKEFILE_TARGET_RE` to exclude `:=`. Add a module-docstring section listing the known-unhandled cases ("monorepo subdir manifests not scanned by design").
category: tech_debt
---

This is genuine `tech_debt` (not `bug_risk`) because the worst-case is mildly inaccurate documentation in plan-context.md, not a runtime failure. The repo-map already degrades gracefully on weird inputs (worst case: empty Build/test commands section + a note that no commands were detected).
