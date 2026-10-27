# Change Request — 2026-05-27-generalize-stage-context-md-followups

## Bounce 1 — 2026-05-27T00:00:00Z — timothy.shee

**Scope:** Implementation
**Severity:** Tweak (small diff)
**Plan/brief impact:** No, just rebuild

### Specific changes requested

The validate subagent flagged finding **F-001 (major)**: on the canonical user path (`agent-workbench validate <run_id>`), `cmd_validate.py`'s default-mode `validating -> followups` transition does NOT call `_write_followups_context_artifacts()`. Only `cmd_followups.py --init` writes the file, and that path is rare. Direct evidence: after this very run's validate finalize, `runs/<id>/stages/6_followups/` did not exist.

Net effect: any user driving the lifecycle through the standard slash-command auto-chain (`/validate` directly takes a building-stage run to `human_review` via `validating -> followups -> human_review`) gets no `followups-context.md`. The §5 contract is violated for the majority case.

**Fix** (the subagent's recommendation): in `agent-workbench-live/lib/cli/cmd_validate.py`'s default-mode path, after the staged `validating -> followups` transition succeeds, call `_write_followups_context_artifacts(...)`. Mirror the existing call site at line 377 (which already invokes `_write_validate_context_artifacts(...)` for the `building -> validating` step).

Specifically:

1. **Add the helper** to `cmd_validate.py` (or import the one from `cmd_followups.py` — pick one; importing is cleaner because it's a one-line delegation).
2. **Call it** in `cmd_validate.py`'s default-mode flow immediately after the `validating -> followups` transition succeeds. The exact insertion point is around `cmd_validate.py:493-518` (the validate subagent flagged this line range).
3. **Add a regression test** to `tests/test_validate_context_build.py` or a new `tests/test_cmd_validate_followups_handoff.py`: drive a synthetic staged run through `validate` default mode (with `validating` status, all artifacts present), assert `stages/6_followups/followups-context.md` exists after `validate` returns successfully and contains the expected lifted sections.
4. **Update `cmd_followups.py`'s docstring** if needed — the line "`--init here` is a convenience shortcut that does the same thing as running `agent-workbench validate <run_id>`" was the inferred-equivalence claim that masked the bug during build. Tighten the language to make the equivalence accurate: BOTH paths now write the curated file.

The previous attempt's build.md § Deviations from plan documents that DR-002/ASM-004 were superseded. That superseding decision was correct as far as it went (write AFTER transition, not before), but the implementer only wired the `--init` path and missed the canonical `cmd_validate` default-mode path. This rebuild closes that gap.

### References

- Handoff: `runs/2026-05-27-generalize-stage-context-md-followups/HUMAN_REVIEW.md`
- Review: `runs/2026-05-27-generalize-stage-context-md-followups/stages/5_validating/review.md`
- Implementation summary: `runs/2026-05-27-generalize-stage-context-md-followups/stages/4_building/build.md`
- F-001 location (the bug): `agent-workbench-live/lib/cli/cmd_validate.py:493-518`
- F-001 fix pattern (mirror this): `agent-workbench-live/lib/cli/cmd_validate.py:377` (existing call to `_write_validate_context_artifacts`)
- Existing helper to call: `agent-workbench-live/lib/cli/cmd_followups.py:212-241` (`_write_followups_context_artifacts`)
