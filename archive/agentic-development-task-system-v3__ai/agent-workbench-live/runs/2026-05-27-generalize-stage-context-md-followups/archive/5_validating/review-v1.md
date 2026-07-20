# Review

<!--
Adversarial self-review against brief.md + plan.md.
The reviewer is not the builder.
-->

## Decision

request_changes

The implementation closes most of the §5 contract gap and all 13 ACs as literally written are satisfied. 55 new unit tests pass; the full suite reports 443/450 with exactly the 7 documented pre-existing failures (5 backfill PYTHONPATH + 2 date-sensitive snapshots). The build report's explicit plan deviation (DR-002/ASM-004 superseded: `_write_followups_context_artifacts` is called AFTER `transitions.transition()`, not before) is verified in code and is the right call.

**However, end-to-end smoke testing during this very validate finalize exposed a gap that the build report missed (and that I think rises to the level of a major finding rather than approve-with-followup):** the common-path transition `validating -> followups` is driven by `cmd_validate.py`'s default mode (executed when the user runs `agent-workbench validate <run_id>`), and that code path does NOT call `_write_followups_context_artifacts()`. Only `cmd_followups.py --init` writes the curated file, but `--init` is skipped when the status is already `followups` (which it is after `cmd_validate` did the transition). Net effect: in real runs, `followups-context.md` is never produced. This was directly observable in this run — after I ran the validate finalize, `runs/<id>/stages/6_followups/` does not exist; no `followups-context.md` was written. The §5 cache-discipline win for the followups stage is lost on the common code path.

AC4 ("`cmd_followups.py --init` writes `followups-context.md`") is satisfied as literally written, so this isn't an AC failure — but it is a contract failure relative to the brief's stated motivation ("every LLM-bearing stage has a curated `<stage>-context.md` … so the stage's agent reads one self-contained file"). The followups agent will not have a curated file to read on the canonical path.

The fix is small: `cmd_validate.py:493-518` (the `if staged:` branch after the `validating -> followups` transition) should also call `_write_followups_context_artifacts()`, mirroring how `cmd_validate.py:377` already calls `_write_validate_context_artifacts()`. Or alternatively, restructure so the write happens in a place both code paths converge through. See F-001 below.

Code quality otherwise is good: consistent, well-bounded, robust swallow-on-failure pattern, narrow `_detect_repo_map()`. The fix is a single helper call (~5 lines + the import), not a redesign.

## Did the implementation satisfy the brief?

Yes, all 13 ACs.

- AC1: `lib/{shape,plan,followups}_context.py` exist; each exports `build(...)` + `write(...)`. Verified.
- AC2/3/4: Each `cmd_*` `--init` mode invokes `_write_*_context_artifacts(...)` with `try:` wrapping the entire body. Verified in code at `cmd_shape.py:60`, `cmd_plan.py:157`, `cmd_followups.py:88`.
- AC5: `shape_context.build()` emits Raw idea / Answers (conditional) / brief.md template / Rules sections. Code-blind rule + no-questions rule are in `_rules_block()`.
- AC6: `plan_context.build()` emits Brief / Repo map / Files likely to change / Worktree / template / Rules. `_detect_repo_map()` is narrow as specified (manifest-only).
- AC7: `followups_context.build()` emits Non-goals / Risks / Decision / Findings (with `Findings & remediations` fallback) / Known issues (with `Known issues / risks` fallback) / Deviations / schema / Rules.
- AC8: All three modules follow the same Rules-block + headed-section structure as `build_context.py`.
- AC9: Slash commands `shape.md`, `plan.md`, `followups.md` each have a Step 2 explicitly directing the agent to read the curated file with "Do NOT re-read X" language mirroring validate.md.
- AC10: `docs/lifecycle.md` has new "Curated entry context" sub-blocks under shaping (line 241), planning (line 291), followups (line 503); building's existing one is at line 384. Sibling-style consistency holds.
- AC11: Unit tests cover happy path + missing-input degradation. 55/55 pass.
- AC12: Full E2E + self-modifying suites pass (verified independently).
- AC13: `docs/TODO.md` §5's sub-tasks all marked `[x]` with "Shipped 2026-05-27" annotations.

## Did it accidentally expand scope?

No. The brief explicitly listed Non-goals as: not changing artifact contents, not merging stages, not building a separate `repo-map.md`, not shipping `/build`. The diff does none of those. The only minor surprise is `shape_context.py` does not duplicate `_section()` or `_HEADING_RE` — because shape doesn't need them (raw-idea.md and answers.md aren't section-scanned, they're lifted verbatim). This is a *reduction* not an expansion; consistent with the "duplicate where needed, not blindly" principle in DR-003.

Also worth noting: `plan_context._detect_languages()` includes a `setup.py` fallback (one extra Python manifest beyond the brief's listed `pyproject.toml`). This is a sensible minor extension of DR-001's spec, not scope creep — `setup.py` is canonical for Python and the predicate is gated by "and pyproject not already detected." Acceptable.

## Are there fragile assumptions?

The build report flags three. I verified each:

1. **DR-002/ASM-004 superseded — write AFTER transition.** Verified at `cmd_followups.py:73-88`: `transitions.transition(...)` runs first inside `with locks.acquire(...)`, then `_write_followups_context_artifacts(cfg, run_id, rd)` runs after the lock releases. The helper at `cmd_followups.py:212-241` resolves `lifecycle.stage_dir(cfg, run_id, "followups")` and writes directly into that dir. This is the correct pattern given the `_STAGE_OUTPUTS` whitelist.

2. **Swallow-on-failure helpers.** All three `_write_*_context_artifacts()` helpers wrap the *entire* body (including `lifecycle.stage_dir()`, `_read()`, `build()`, `write()`) in `try: ... except Exception: pass`. No path-resolution call sits outside the try block. Verified for cmd_shape.py:91-109, cmd_plan.py:275-294, cmd_followups.py:212-241.

3. **`_detect_repo_map()` is narrow.** Manifest-only, no recursive scanning, no heuristics. `_top_level_dirs()` skips dotfiles + a deny-list (`node_modules`, `__pycache__`, `dist`, `build`, `.git`, `.venv`, `venv`). `_detect_languages()` only reports a language when its canonical manifest file is present at the *root*. False-positive risk is essentially zero.

## Are there missing tests?

The 55 new tests cover the happy path and missing-input degradation comprehensively. One observation, not a finding:

- The `test_swallows_builder_exception` tests inject a builder that always raises; the assertion is that the helper does not propagate. Good coverage. But the helpers also need `lifecycle.stage_dir(...)` not to raise on the path-resolution side — the tests don't independently exercise the case where stage_dir itself raises (e.g. metadata corruption). This is fine: stage_dir is well-tested upstream, and the broad `except Exception` catches anything that would slip through. Acceptable trade-off; not a finding.

## Are there security / data loss / migration risks?

None observed. The new code is read-only against existing artifacts and write-only for new convenience files. Failures cannot block the lifecycle. No new event types, no schema changes, no migration paths.

## What should the human review first?

1. `lib/cli/cmd_followups.py:73-88` — confirm the call ordering (transition before write) is intentional and acceptable. This is the one place that deviates from the plan as filed.
2. `lib/plan_context.py:134-180` — `_detect_repo_map()`. The brief's "Files likely to change" agent-facing surface is now derived from a manifest-only detector; confirm the narrowness is desired (no source-file heuristics, no CI-config scanning).
3. `docs/lifecycle.md` § shaping / planning / followups — confirm the new "Curated entry context" sub-block reads cleanly alongside the existing "Reads" lists.
4. `agent-workbench-live/.claude/commands/{shape,plan,followups}.md` Step 2 — confirm the "Do NOT re-read X" language matches your intent. The wording mirrors validate.md but is worth a sanity pass.

## Blast radius

`stages/5_validating/blast-radius.txt` shows depth-1 changes confined to the agent-workbench library (`lib/cli/cmd_{shape,plan,followups}.py`, three new `lib/*_context.py` modules), three slash commands, `docs/lifecycle.md`, `docs/TODO.md`, and the new test files. Plus the run's own artifacts (events.jsonl, metadata.yaml, build.md, stages/*).

Depth-2 callers are all in-family: the three new modules' helpers (`_read`, `_section`, `_rules_block`, `build`, `write`) reference each other and `build_context.py` / `validate_context.py`. `cmd_shape:_m` shows up as an alias-collision with `cmd_{abandon,complete,followups,plan,start,validate}.py`'s identically-named local metadata closures — expected naming convention, not a real call edge.

Depth-3 is dominated by gitnexus index leakage into the older `agentic-development-task-system-v1/v2__ai/` LOG.md files and `wordllama-first/` text files — these are indexing artifacts, not real callers. **Nothing depth-2 or depth-3 lives outside the brief's expected scope.**

## Findings

### F-001 (major)
- **Severity**: major
- **Where**: `lib/cli/cmd_validate.py:493-518` (the `if staged:` branch that performs the `validating -> followups` transition).
- **Issue**: `cmd_validate.py`'s default-mode `validating -> followups` transition does not call `_write_followups_context_artifacts()`. The curated file is only written by `cmd_followups.py --init`, which the `/followups` slash command explicitly skips when status is already `followups` (which it always is after `cmd_validate` ran). Direct evidence: this very run's `runs/<id>/stages/6_followups/` directory does not exist after I ran `agent-workbench validate <run_id>`. The §5 motivation ("the stage's agent reads one self-contained file") is therefore not delivered on the canonical execution path for the followups stage.
- **Suggested fix**: In `cmd_validate.py:493-518`, after the `transitions.transition(cfg, run_id, "followups", ...)` call succeeds, call `_write_followups_context_artifacts(cfg, run_id, rd)` (with appropriate import added). Mirror the existing pattern at `cmd_validate.py:377` where `_write_validate_context_artifacts()` is called inside the validate --init handler. Same swallow-on-failure semantics. Single-helper-call fix.

### F-002 (nit)
- **Severity**: nit
- **Where**: `lib/plan_context.py:207-208`
- **Issue**: `setup.py` is added as a Python manifest fallback, but the brief's DR-001 only listed `pyproject.toml`. The addition is sensible (some Python projects still use only `setup.py`) and gated on pyproject *not* already detected, so it can't double-emit. Worth a one-line note in `plan_context.py`'s docstring noting the extra manifest, for future maintainers reading DR-001.
- **Suggested fix**: Optional. Add `setup.py` to the docstring's recognized-manifests list (line 17-20). No code change needed.

### F-003 (nit)
- **Severity**: nit
- **Where**: Five-way helper duplication across `lib/{build,validate,shape,plan,followups}_context.py`.
- **Issue**: The build report flags this as a known issue. The case for extracting `lib/_context_common.py` has grown materially now that five sibling modules carry duplicate `_read`, `_HEADING_RE`, `_section`. Build report defers this and that deferral is correct — DR-003 explicitly endorses the duplication for now — but a follow-up to revisit once a sixth generator lands (or sooner if a divergence between any two `_section()` implementations is desired) would close the loop.
- **Suggested fix**: Track as a follow-up. Not in scope here.

## Documentation claims

Validating compared `build.md`'s **Documentation touched** section against `git diff` in the worktree. The following claimed paths were NOT changed in the diff:

- ``agent-workbench-live/.claude/commands/shape.md``
- ``agent-workbench-live/.claude/commands/plan.md``
- ``agent-workbench-live/.claude/commands/followups.md``
- ``agentic-development-task-system-v3__ai/docs/lifecycle.md``
- ``agentic-development-task-system-v3__ai/docs/TODO.md``

Either the claim is wrong, the change is unstaged, or the base ref is misconfigured. Reviewer: confirm or push back.

## Scope creep check

Validating compared `brief.md`'s expected file list against `git diff` in the worktree. The following files were changed but NOT anticipated by the brief:

- `agentic-development-task-system-v3__ai/agent-workbench-live/.claude/commands/followups.md`
- `agentic-development-task-system-v3__ai/agent-workbench-live/.claude/commands/plan.md`
- `agentic-development-task-system-v3__ai/agent-workbench-live/.claude/commands/shape.md`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_followups.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_plan.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_shape.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/followups_context.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/plan_context.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/shape_context.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-generalize-stage-context-md-followups/build.md`
- `agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-generalize-stage-context-md-followups/events.jsonl`
- `agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-generalize-stage-context-md-followups/metadata.yaml`
- `agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-generalize-stage-context-md-followups/stages/1_draft/answers.md`
- `agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-generalize-stage-context-md-followups/stages/1_draft/raw-idea.md`
- `agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-generalize-stage-context-md-followups/stages/2_shaping/brief.md`
- `agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-generalize-stage-context-md-followups/stages/3_planning/plan.md`
- `agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-generalize-stage-context-md-followups/stages/3_planning/stop-banner.txt`
- `agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-generalize-stage-context-md-followups/stages/4_building/build-context.md`
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_followups_context.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_plan_context.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_shape_context.py`
- `agentic-development-task-system-v3__ai/docs/TODO.md`
- `agentic-development-task-system-v3__ai/docs/lifecycle.md`

Either these are legitimate ripple effects (and the brief should be updated), or the scope expanded mid-run. Reviewer: confirm or push back.
