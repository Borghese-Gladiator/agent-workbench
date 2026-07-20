# Follow-ups

These candidates emerged from the dogfood validation of TODO §1. None
were executed in this run.

---
title: Resolve scope_check path-prefix ambiguity
motivation: This dogfood run exposed that `brief.md`'s "Files likely to change" section author has no way to know whether to write `agent-workbench-live/lib/run_ids.py` (workbench-relative) or `agentic-development-task-system-v2__ai/agent-workbench-live/lib/run_ids.py` (worktree-root-relative, which is what `git diff --name-only` emits). Every actual file got flagged as creep even though the implementation matched the brief exactly. The gate fires loudly but for the wrong reason.
suggested_scope: Decide on one convention and document it in `templates/brief.md`'s "Files likely to change" section comment. Optionally normalize paths in `lib/scope_check.detect_creep` by stripping a configurable repo-prefix (workbench root vs. monorepo root). Add a unit test for the normalization.
category: bug_risk
---

This is the most pressing issue from the dogfood. The §1g gate is
functioning correctly — it's the authoring contract that's underspecified.

---
title: Add dedicated unit tests for extract_run_date
motivation: AC-5 of the current brief called for unit tests on `lib/run_ids.py`'s new helper. The implementation only exercised the happy path via the integration test. Malformed run_id handling (empty string, missing date prefix, garbage prefix) is not covered.
suggested_scope: Add `tests/test_run_ids.py` covering: empty string, missing date prefix (just a slug), malformed date prefix (e.g. `99-99-99-foo`), valid case, and the `NamingError` path.
category: tech_debt
---

---
title: Render the build: block in `agent-workbench show`
motivation: TODO §1e added a `build:` block to metadata.yaml with iterations / exit_reason / max_iterations. These are now part of the run's source of truth but the `agent-workbench show` command doesn't render them. A reviewer running `show` to triage doesn't see the build-loop telemetry.
suggested_scope: Update `lib/cli/cmd_show.py` (or wherever the renderer lives) to print the build block alongside `validation:` and `completion:`. One small block, three lines.
category: docs
---

---
title: Parser drops multi-line decision/assumption bodies
motivation: The ASM/DR parser in `lib/cli/cmd_plan.py` uses `(.*)$` to capture the body of each `- **Field**: …` line. For multi-line entries (e.g. DR-001 in this run's plan.md, whose Decision wraps across lines), only the first line is captured and `AssumptionRecorded`/`DecisionRecorded` events store truncated content.
suggested_scope: Extend the parser to capture continuation lines (lines indented more than the dash line, until the next `- **Field**:` or `###` heading). Add tests for multi-line ASM and DR bodies. Pre-existing limitation, not introduced by Renovate.
category: tech_debt
---

---
title: Number stage directories by execution order
motivation: Today `stages/<stage>/` directory names sort alphabetically (`building/ draft/ followups/ planning/ shaping/ validating/`), which has nothing to do with the lifecycle flow. A reviewer landing in a run dir sees the stages jumbled. Same problem in `archive/<stage>/` after a bounce. Prefixing each directory with its 1-based execution-order number makes `ls` show them top-to-bottom in lifecycle order: `1_draft/ 2_shaping/ 3_planning/ 4_building/ 5_validating/ 6_followups/`. Same for archive. Small change, big readability win at triage time.
suggested_scope: Update `lib/lifecycle.py` `stage_dir` / `archive_dir` helpers and the `_STAGE_OUTPUTS` move table to use numbered names. Update HUMAN_REVIEW.md hub links + slash command docs (`/followups`, `/validate`) for the new paths. Update integration tests that assert against `stages/shaping/brief.md` etc. Update `docs/lifecycle.md` and template `HUMAN_REVIEW.md`. Decide whether to also rename `qa-v<N>` archives. Existing flat-layout runs unaffected. Existing staged runs in flight at the time of the change: do NOT rename (write a one-line note in `lifecycle.md`).
category: refactor
---
