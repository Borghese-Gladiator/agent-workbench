# Brief

## Goal

Close the §5 contract gap: every LLM-bearing stage in the agent-workbench lifecycle must have a curated `<stage>-context.md` file generated at `--init` time, so the stage's agent reads one self-contained file instead of re-reading prior artifacts. Three siblings remain — `plan-context.md`, `followups-context.md`, `shape-context.md` — alongside the already-shipped `build-context.md` and the pre-existing `validate-context.md`.

The two motivating wins are unchanged from the original §5 framing:

1. **Cache footprint.** One curated read per stage replaces the N-file re-read pattern (brief + plan + decisions + QA report + …). Each re-read sticks in the master session's prefix forever; one curated file collapses that into a single sticky read.
2. **Subagent-readiness.** A self-contained `<stage>-context.md` is the natural input for an Agent-tool subagent — pass that one file, get back structured findings, master's prefix stays clean. The pattern matches `Explore`-style read-only subagents and is the prerequisite for any future planner/builder/reviewer that wants to be subagent-driven.

## User-facing behavior

For the three target stages, the user (the human running slash commands) sees:

- `agent-workbench shape "$RUN_ID" --init` writes `runs/$RUN_ID/shape-context.md` in addition to the existing `brief.md` template stage.
- `agent-workbench plan "$RUN_ID" --init` writes `runs/$RUN_ID/plan-context.md` in addition to the existing `plan.md` template stage.
- `agent-workbench followups "$RUN_ID" --init` writes `runs/$RUN_ID/followups-context.md` in addition to the existing `follow-ups.md` template stage.

The corresponding slash-command bodies (`.claude/commands/shape.md`, `plan.md`, `followups.md`) gain a step that says "Read `runs/$RUN_ID/<stage>-context.md` first. Do NOT re-read raw-idea.md / brief.md / plan.md / review.md etc. separately if `<stage>-context.md` already covers what you need." This mirrors the language already present in `validate.md` step 2 and is the same mechanism `build-context.md` will plug into once `/build` ships under §3.

No new top-level CLI commands. No new lifecycle stages. The artifacts the existing stages produce (brief.md, plan.md, build.md, review.md, follow-ups.md) are unchanged in shape and contents — the new `*-context.md` files are *additive* curated reads, not replacements.

For each new file, if its generator fails (e.g., a prior artifact is malformed), the failure is swallowed exactly as `cmd_validate.py` swallows `validate_context.build` failures today: a warning to stderr, no new file, the transition still succeeds. Curated context is a convenience artifact; it never blocks the lifecycle.

## Acceptance criteria

1. `lib/shape_context.py`, `lib/plan_context.py`, `lib/followups_context.py` exist and expose a public `build(...)` (or equivalently named) function that takes the run's prior artifacts and a worktree path and returns a rendered string.
2. `lib/cli/cmd_shape.py`'s `--init` mode writes `runs/$RUN_ID/shape-context.md` after staging `brief.md`; failures are swallowed with a stderr warning.
3. `lib/cli/cmd_plan.py`'s `--init` mode writes `runs/$RUN_ID/plan-context.md` after staging `plan.md`; failures are swallowed with a stderr warning.
4. `lib/cli/cmd_followups.py`'s `--init` mode writes `runs/$RUN_ID/followups-context.md` after staging `follow-ups.md`; failures are swallowed with a stderr warning.
5. `shape-context.md` contains: verbatim raw-idea.md, verbatim answers.md (if present), brief.md template skeleton inlined with one-line section descriptions, and the two shaping rules ("no code reading, no questions").
6. `plan-context.md` contains: full brief.md, a repo-map block (top-level dirs + detected languages + build/test commands sourced from `agent-workbench.yaml` policies or the worktree), the brief's "Files likely to change" section lifted inline, plan.md template skeleton, and the planning rules reminder ("may read code, may not ask questions, record assumptions").
7. `followups-context.md` contains: brief's Non-goals, plan's Risks, review's Decision + findings, qa report's Known issues, build's Deviations from plan, the follow-ups.md schema (category enum + frontmatter rules), and the followups rules reminder ("read-only, 1–5 entries or `no_followups` sentinel").
8. Each new context file uses the same Rules-block + headed-section structure as the existing `build-context.md` so the three siblings are visually consistent with the design template.
9. `agent-workbench-live/.claude/commands/shape.md`, `plan.md`, `followups.md` each have a step-1 instruction to read `runs/$RUN_ID/<stage>-context.md` first, mirroring `validate.md` step 2's "Do NOT re-read X if `<stage>-context.md` already covers what you need" language.
10. `docs/lifecycle.md` gains a `*-context.md` row in each of the three stage tables, sibling to "Reads" and "Produces."
11. Unit tests in `tests/test_shape_context.py`, `tests/test_plan_context.py`, `tests/test_followups_context.py` exercise the happy path (all upstream artifacts present, all expected sections appear in the rendered file) and the missing-input path (no answers.md / no qa report / no review.md — the generator degrades gracefully, no crash).
12. The full E2E test suite (`tests/test_e2e.py`, `tests/test_self_modifying.py`) continues to pass — the new generators must not break existing transitions.
13. The TODO §5 task list (in `docs/TODO.md`) is updated to mark the three remaining sub-tasks as shipped (or shape-context.md as built per the answers.md decision).

## Non-goals

- **Changing the contents of brief.md, plan.md, build.md, review.md, follow-ups.md.** The templates and the agent-authored outputs are untouched.
- **Shipping `/build` or `build-context.md` regeneration on bounce.** Both are §3's territory.
- **Merging stages or changing the lifecycle.** No new stages, no removed stages, no transition-graph edits.
- **Building a `repo-map.md` as a standalone artifact.** The repo-map content lives inline inside `plan-context.md`; no sibling file.
- **Refactoring or rewriting the existing `lib/build_context.py` or `lib/validate_context.py`.** Those are the reference design; new generators may share helpers, but the existing two stay behavior-compatible.
- **Subagent-driven planner / builder / reviewer.** This run only produces the curated files; *using* them as subagent inputs is a follow-up (likely tied to §10).
- **Cross-machine consistency of the worktree path inside `plan-context.md`.** The repo-map references the local worktree; the file is regenerable, not portable.
- **Restructuring `cmd_validate.py`'s try/except swallow pattern.** The three new generators reuse the same shape (warn on failure, never block); cleanups to the pattern itself are out of scope.

## Good examples

- The shipped `lib/build_context.py` + `lib/cli/cmd_start.py`'s `_write_build_context_artifacts` helper. That pair is the canonical pattern: a `lib/<stage>_context.py` module owns rendering, the corresponding `cmd_<stage>.py --init` writes the file, the slash-command body tells the agent to read it. The three new siblings should look almost identical in shape — same file boundary, same failure-swallow contract, same Rules block at the top of the rendered file.
- The pre-existing `lib/validate_context.py` + `tests/test_validate_context_build.py` shows the rendering-and-testing pattern for a context file that includes a template skeleton + lifted-from-prior-artifacts content + a worktree metadata block.
- `validate.md` step 2's exact wording — "Do NOT re-read X if `<stage>-context.md` already covers what you need" — is the language to mirror in the three slash-command updates.

## Bad examples

- Reading raw-idea.md / brief.md / plan.md / review.md / qa report directly from inside the slash command body when the context file is supposed to be the single curated read. (Beats the cache-footprint win.)
- Generating a context file whose contents are stale relative to the staged template (e.g. lifting an outdated copy of the plan.md skeleton). The generator should re-read the live template each time.
- Crashing the `--init` transition when a prior artifact is malformed (e.g. brief.md has unexpected headings). The contract is "warn, write nothing, return". Anything else regresses on the convenience-artifact-must-not-break-the-transition rule already established by `cmd_validate.py`.
- Shipping `plan-context.md` without a repo-map block (the planner needs to know what languages, what build/test commands, what top-level dirs exist before reading code). A skeleton-only plan-context loses most of its leverage.
- A `followups-context.md` that just dumps every prior artifact in full — it needs to be *curated* (Non-goals + Risks + findings + Known issues + Deviations only), otherwise it's just a concatenation and pays the cache cost without the curation win.

## Constraints

- The workbench is self-modifying; this run targets the workbench itself (the run dir lives inside the worktree, master stays clean). All changes land via the `agent/<slug>` branch's `cmd_complete` merge.
- The existing `validate-context.md` and `build-context.md` are the design templates — new files must structurally resemble them (Rules block on top, headed sections below, worktree metadata footer where it applies).
- The three new generators must use the *same* failure-swallow contract as `cmd_validate.py`'s try/except — never block a transition because of a context-file render error.
- Templates referenced by the new generators (`templates/brief.md`, `templates/plan.md`, `templates/follow-ups.md`) must be re-read live each time, not snapshotted at module import.
- Unit tests must mirror the shape of `tests/test_build_context.py` and `tests/test_validate_context_build.py` — synthetic prior artifacts → assert rendered file has the expected sections. No live-CLI integration test required at the generator level; the E2E suite covers the CLI integration.
- No new third-party Python dependencies. Standard library + the existing `yaml_io` / `metadata` / `runs` / `repos` helpers only.

## Assumptions

- The `lib/build_context.py` + `lib/validate_context.py` modules expose enough of a public surface that the three new generators can borrow patterns (the try/except swallow, the Rules-block-on-top convention, the worktree-metadata footer block) without first refactoring either. If they don't, the planner can flag whether a small extraction (e.g. a shared `_render_rules_block` helper) is warranted; otherwise the three new modules duplicate the small amount of scaffolding.
- The `agent-workbench.yaml` policies block carries enough information for `plan-context.md` to surface build/test commands deterministically — if a target repo has no policies entry, the repo-map falls back to "auto-detected from worktree" with a one-line note.
- The `templates/follow-ups.md` template exists and has the schema (category enum + frontmatter rules) the §5 task list references. If the template needs new sections to support the new generator, that's an incidental edit covered by this run.
- The "Files likely to change" section in brief.md may or may not be present (it's not a required brief section); when missing, `plan-context.md`'s lift-inline behavior degrades to "no `Files likely to change` block, no warning."
- The three new generators do NOT need to re-validate the prior artifacts' shape — they parse permissively, render what they find, and skip sections that are absent or empty. The validate-init silent-template-fallback (called out separately under §4) is out of scope for this run.
- The `--init` step is the only write point for each new file in this run's scope. Regeneration on bounce / mid-stage refresh is §3-adjacent and out of scope.

## Suggested QA scenarios

1. **Happy path, all upstream artifacts present.** Create a synthetic run, stage all prior artifacts (raw-idea, answers, brief, plan, build, review, qa report), invoke each stage's `--init`, assert each `*-context.md` exists with all expected sections.
2. **Sparse upstream — minimum artifacts.** Stage only what's strictly required for each stage (shape: just raw-idea; plan: just brief; followups: brief + plan + qa report). Assert each generator degrades gracefully — missing sections rendered as `(absent)` or skipped entirely, no crash.
3. **Malformed prior artifact.** Stage a `brief.md` with unexpected heading structure, invoke `plan --init`. Assert: the transition still succeeds, no `plan-context.md` is written, a one-line warning appears on stderr.
4. **Self-modifying run, full lifecycle.** Drive the full happy path on the workbench-itself target: `/new-run → /draft → /shape → /plan → /start → /build → /validate → /followups → /complete`. Assert each of the three new `*-context.md` files appears in the corresponding stage dir after the stage transitions out, and that the run completes cleanly.
5. **Bounce path.** From `human_review`, run `/bounce` back to `planning`, then `/plan --init` again. Assert `plan-context.md` is re-rendered against the now-updated brief/answers; the file is overwritten, not appended.
6. **Slash command read.** Spot-check by running `/shape`, `/plan`, `/followups` in a real run (after the changes land) and confirming each command's step-1 invocation points at `<stage>-context.md` rather than the prior artifacts.

## Files likely to change

- `agent-workbench-live/lib/shape_context.py` (new)
- `agent-workbench-live/lib/plan_context.py` (new)
- `agent-workbench-live/lib/followups_context.py` (new)
- `agent-workbench-live/lib/cli/cmd_shape.py` (extend `--init` to write `shape-context.md`)
- `agent-workbench-live/lib/cli/cmd_plan.py` (extend `--init` to write `plan-context.md`)
- `agent-workbench-live/lib/cli/cmd_followups.py` (extend `--init` to write `followups-context.md`)
- `agent-workbench-live/.claude/commands/shape.md`
- `agent-workbench-live/.claude/commands/plan.md`
- `agent-workbench-live/.claude/commands/followups.md`
- `agent-workbench-live/tests/test_shape_context.py` (new)
- `agent-workbench-live/tests/test_plan_context.py` (new)
- `agent-workbench-live/tests/test_followups_context.py` (new)
- `agent-workbench-live/templates/brief.md` (read-only reference; may need section-description comments if missing)
- `agent-workbench-live/templates/plan.md` (read-only reference; same caveat)
- `agent-workbench-live/templates/follow-ups.md` (read-only reference; same caveat)
- `agent-workbench-live/docs/lifecycle.md` (add `*-context.md` rows to the three stage tables)
- `docs/TODO.md` (mark §5 sub-tasks complete)
