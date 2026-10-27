# Follow-ups

---
title: Extract _read / _section / _HEADING_RE / _collect_id_blocks into lib/_context_common.py
motivation: With five context-md generators now in the family (build, validate, shape, plan, followups), the helper duplication has stopped being prudent and started being maintenance friction. Any future tweak to `_section()`'s heading-matching behavior has to land in four places (shape doesn't use it). The original duplication rationale ("the two builders may diverge") was sound when there were two; with five, the divergence risk is overstated and the consistency cost is real.
suggested_scope: One run. Add lib/_context_common.py exposing `_read`, `_section`, `_HEADING_RE`, `_collect_id_blocks`. Update all five generators to import. Keep each generator's `_rules_block()` and stage-specific helpers local. Update each generator's module docstring to remove the "duplicated locally" rationale paragraph. Tests unchanged (public surface stays the same).
category: refactor
---

The §5 run's plan recorded this as DR-003 (keep duplication) plus a "Known issues" note. With shape/plan/followups landed, the cost-benefit has shifted. The first validate subagent flagged it as F-003 (nit). Cost of the refactor is small; cost of NOT doing it grows linearly with future generator additions and with each helper tweak.

---
title: Tighten plan_context._detect_repo_map() heuristics or document the trade-offs
motivation: The detection rules are narrow (manifest files only, no recursive scanning), but a few corners aren't covered: monorepos with multiple pyproject.toml files under top-level subdirs (only the root one is checked); package.json scripts whose values contain commas (the script-name extraction regex is permissive); Makefile targets with `:=` assignments vs `:` rules (the current regex matches both, treating an assignment as a target). None of these is dangerous — worst case is one slightly-wrong line in plan-context.md — but the §5 run only validated against the 6 happy-path cases.
suggested_scope: One small run. Add 3–5 edge-case tests to tests/test_plan_context.py covering monorepo subdirs, package.json edge cases, and Makefile assignment-vs-rule disambiguation. Tighten `_MAKEFILE_TARGET_RE` to exclude `:=`. Add a module-docstring section listing the known-unhandled cases ("monorepo subdir manifests not scanned by design").
category: tech_debt
---

This is genuine `tech_debt` (not `bug_risk`) because the worst-case is mildly inaccurate documentation in plan-context.md, not a runtime failure. The repo-map already degrades gracefully on weird inputs.

---
title: Harden cmd_validate.py's lazy followups-context import against ImportError
motivation: Bounce-pass 2 validate flagged this as F-002 (nit). The fix for F-001 added `from lib.cli.cmd_followups import _write_followups_context_artifacts` inside cmd_validate.run()'s default-mode flow, NOT wrapped in try/except. The followups-context helper itself has try/except, but if `cmd_followups` ever becomes unimportable (a future module-level edit breaks imports, an upstream dep yanked, etc.), the import statement raises before the helper's safety net engages. Net effect: a hard crash AFTER `transitions.transition()` already succeeded — partial state, the run is in `followups` but the curated file never gets written and the caller sees a traceback.
suggested_scope: Half a run. Either wrap the import + call in `try/except Exception: pass` (matches the convenience-artifact never-block contract), OR promote the import to module-level (verified safe — `cmd_followups` doesn't import from `cmd_validate`, no cycle). Module-level is slightly cleaner because it means import errors fail at module load not at run time. Add a test that monkey-patches `cmd_followups._write_followups_context_artifacts` to raise ImportError and asserts cmd_validate.run() still returns 0.
category: bug_risk
---

The reviewer judged it correctly as nit-severity in isolation, but it's `bug_risk`-category because a real future failure mode lives here (any module-level edit to cmd_followups.py that breaks imports would cause cmd_validate to crash mid-transition on every run). The fix is mechanical.

---
title: Document the self-modifying-CLI smoke-test caveat in validate-stage docs
motivation: Bounce-pass 2 validate uncovered that for self-modifying agent-workbench runs, the live smoke test at `validate` finalize (which checks whether the new generator writes its file in the destination stage dir) exercises MASTER's CLI — not the worktree's fix. The `agent-workbench` CLI binary dispatches against its master-side `lib/` modules, so any code change shipping in this run only takes effect AFTER the run merges to master. The validate subagent on bounce-pass 1 implicitly assumed the smoke test would exercise the fix; it did not. This caught a real concern but only because the subagent also ran the regression test directly. Future self-modifying runs that ship CLI-path code changes will hit the same mental-model trap.
suggested_scope: Half a run. Add a paragraph to `agent-workbench-live/.claude/commands/validate.md` (under Step 4 or a new "Self-modifying caveat" subheading) explaining that the validate finalize on a self-modifying run uses master's pre-change CLI, so the live "did the new file appear?" check is not a valid signal for code-path fixes — only unit/integration tests are. Also update `docs/lifecycle.md` § `building` to flag the same caveat for `cmd_complete`'s post-merge dance (where master finally picks up the change).
category: docs
---

The cost of the missing doc is real: the bounce-pass 2 validate subagent spent investigation effort to figure out why the live smoke test didn't show the curated file. With the doc in place, the next agent reads "this won't be observable until merge" and skips that wasted investigation.
