# Human review — 2026-05-22-context-graph

## Where to start

- Want to see diffs? → `stages/4_building/build.md`
- Want to verify QA? → `stages/5_validating/qa/report.md` (+ `qa/commands.txt`)
- Want to confirm each AC is tested? → `stages/4_building/build.md` § Acceptance criteria coverage
- Want to argue with decisions? → `stages/3_planning/plan.md` § Decisions & assumptions, then `stages/5_validating/review.md`
- Want to see what's next? → `stages/6_followups/follow-ups.md`

## Suggested first checks

```bash
# Confirm the tree
find agent-workbench-live/context -name '*.md' | wc -l   # expect 19 (after the meta trim)
find agent-workbench-live/context -name '*.md' -exec wc -l {} +

# Run the structural invariants
python -m unittest discover -s agent-workbench-live/tests -t agent-workbench-live -p test_context_library.py -v

# Run the full suite
python -m unittest discover -s agent-workbench-live/tests -t agent-workbench-live
```

1. Open `agent-workbench-live/context/README.md` and scan the section grouping — do the one-liners convey what each leaf is for?
2. Open `agent-workbench-live/context/git/commit.md` and `agent-workbench-live/context/languages/python/testing.md`. Confirm both honor the four-marker template, fit on one screen, and lead with examples over prose.
3. Open `AGENTS.md` (repo root) and `agent-workbench-live/AGENTS.md`. Confirm the new "Context library" section references `@context/README.md` without inlining file paths.
4. Open `CLAUDE.md` (new file at the repo root). Confirm it references `@context/README.md` and `@context/AUTHORING.md`.

If steps 1–4 pass and the unit suite is 198/198 green, the run is delivered.

## Run timeline

- 2026-05-22 — Draft created from TODO §1 (Context Graph).
- 2026-05-22 — Shape → brief.md transcribed code-blind from TODO §1; transition `draft → shaping → planning`.
- 2026-05-22 — Plan → merged staged plan.md authored with 5 decisions + 3 assumptions; transition `planning → ready`.
- 2026-05-22 — Approved by `$USER`; transition `ready → building`. Worktree created at `worktrees/agentic-development-task-system-v2-ai/20260522__context-graph/` on `agent/context-graph`.
- 2026-05-22 — Build → `context/` tree, AGENTS+CLAUDE wiring, 5 slash-command `Context:` imports, `tests/test_context_library.py`. Suite 193 → 198 green.
- 2026-05-22 — Mid-handoff revert: 5 slash-command `Context:` lines removed (judged decorative).
- 2026-05-22 — Mid-handoff trim: `meta/repo-discovery.md` + `meta/risk-and-approval.md` deleted; `context-authoring.md` promoted to `context/AUTHORING.md`. Net: 19 files.
- 2026-05-22 — Validate → adversarial self-review (decision: approve, no findings), QA report (198/198), blast radius traced to depth 3 with no scope creep.
- 2026-05-22 — Followups → forward-looking candidates authored (see `stages/6_followups/follow-ups.md`).
- 2026-05-22 — Transition `followups → human_review`. Ready for the human.
