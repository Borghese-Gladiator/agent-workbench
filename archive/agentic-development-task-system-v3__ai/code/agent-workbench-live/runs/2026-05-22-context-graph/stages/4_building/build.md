# Build report

## What changed

Added the `agent-workbench-live/context/` library — 19 files net after a mid-handoff trim: README + `AUTHORING.md` at the root, then leaves under `git/`, `languages/{python,javascript-typescript,go}/`, `infra/`, `diagnostics/`. Wired both AGENTS.md files and a new repo-root `CLAUDE.md` to reference the library via `@context/README.md`. Added `tests/test_context_library.py` to lock in the structural invariants: tree exists, four-marker template, ≤60-line cap, README indexes every leaf, no `workflows/` subdir. Two task items shipped then walked back on user review (see "Deviations from plan").

## Files changed

**Added**

- `CLAUDE.md` — thin repo-root file pointing at `@context/README.md` + `@context/AUTHORING.md`.
- `agent-workbench-live/context/README.md` — primary discovery entrypoint; indexes every leaf with `@context/...` imports.
- `agent-workbench-live/context/AUTHORING.md`
- `agent-workbench-live/context/git/commit.md`
- `agent-workbench-live/context/git/worktrees.md`
- `agent-workbench-live/context/git/draft-pr.md`
- `agent-workbench-live/context/languages/python/{setup,dependencies,testing,quality}.md`
- `agent-workbench-live/context/languages/javascript-typescript/{setup,dependencies,testing,quality}.md`
- `agent-workbench-live/context/languages/go/{setup,dependencies,testing,quality}.md`
- `agent-workbench-live/context/infra/{secrets,shell,docker,ci,sql-migrations}.md`
- `agent-workbench-live/context/diagnostics/sentry-bug-triage.md`
- `agent-workbench-live/tests/test_context_library.py`

**Modified**

- `AGENTS.md` — added a "Context library" section that points at `@context/README.md`; added a CLAUDE.md bullet under Related conventions.
- `agent-workbench-live/AGENTS.md` — added a "Context library" section above "Where to read more".

**Initially modified, then reverted on user request** (see "Deviations from plan"):

- `agent-workbench-live/.claude/commands/{plan,validate,start,followups,new-run}.md` carried a single `Context: @context/...` import line in commit `3214b68`; reverted in the follow-on revert commit because AGENTS.md auto-loading + `@context/README.md` already give the agent a discovery path and the per-command pre-declarations were judged decorative.

## Reviewer reading order

1. `agent-workbench-live/context/README.md` — see how the library is indexed and how each section is grouped.
2. `agent-workbench-live/context/AUTHORING.md` — read this to understand the four-marker template, then sample any two leaves to confirm the template is honored.
3. `agent-workbench-live/tests/test_context_library.py` — the structural invariants; if a future agent breaks the template, this test fails.
4. `agent-workbench-live/AGENTS.md` — confirm the new "Context library" section points at `@context/README.md` and does NOT inline file lists.
5. `CLAUDE.md` (repo root) — confirm it references `@context/README.md` + `@context/AUTHORING.md`.
6. `git log -p -- agent-workbench-live/.claude/commands/` — confirm no slash-command file is modified on the branch (the original feat commit added `Context:` lines; the follow-on revert removed them).

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| Directory tree exists exactly as specified (19 files after the meta trim) | `tests/test_context_library.py::TestDirectoryTree::test_every_required_file_exists` |
| Every non-README has the four-marker template | `tests/test_context_library.py::TestLeafFileTemplate::test_each_non_readme_has_four_markers` |
| Every non-README ≤~50 lines (≤60 hard) | `tests/test_context_library.py::TestLeafFileTemplate::test_each_non_readme_within_line_cap` |
| `README.md` indexes every other file with `@context/...` import | `tests/test_context_library.py::TestReadmeIndex::test_readme_indexes_every_leaf` |
| No `context/workflows/` directory | `tests/test_context_library.py::TestDirectoryTree::test_no_workflows_subdir` |
| `AGENTS.md` (root + workbench) references `@context/README.md` without inlining the file list | Visual review of the new "Context library" sections in `AGENTS.md` and `agent-workbench-live/AGENTS.md`; neither lists files. |
| `CLAUDE.md` references the README | Visual review of `CLAUDE.md` — references `@context/README.md` and `@context/AUTHORING.md`. |
| Relevant `.claude/commands/*` compose targeted imports | Initially landed in commit `3214b68` (5 commands with `Context:` lines); reverted on user judgment that AGENTS.md auto-loading + the README index already give Claude lazy access to leaves on demand. The acceptance criterion is interpreted as "the *library* is composable from commands" — which it is — rather than "each command must pre-declare imports". |
| Existing repo conventions preserved over generic defaults | DR-003 in plan: workbench-itself stdlib `unittest` convention preserved in AGENTS.md; the new `tests/test_context_library.py` uses `unittest`. Worktree placement under `LOCAL_worktrees/` reflected in `@context/git/worktrees.md`. |
| Full suite passes 193 → ≥198 | `python -m unittest discover -s tests -t agent-workbench-live` → `Ran 198 tests in 15.076s OK`. |

## Deviations from plan

Two task items shipped and were walked back on user review.

**Per-command `Context:` lines (5 slash commands).** Landed in commit `3214b68` per DR-001 and the §1 task bullet's examples (`plan` → repo-discovery + risk-and-approval; `validate` → repo-discovery + draft-pr + ci; etc.). User judged them decorative: AGENTS.md and `CLAUDE.md` are auto-loaded by Claude Code, and the `@context/README.md` index gives an agent a lazy discovery path to any leaf on demand. Pre-declaring per-command imports added churn without changing what an agent could actually reach. Reverted in a follow-on commit. DR-001 in the staged plan is therefore narrowed in practice: the rule "one concentrated import block per command" stays sound *if* per-command imports are ever revisited, but the current shipping state is "no per-command imports — the README is the single discovery surface."

**Meta files `repo-discovery.md` and `risk-and-approval.md`.** Authored under TODO §1's "Meta" bullet — generic safety / discovery guidance with `Applies when:` triggers like "opening an unfamiliar repo" and "about to take a risky action." User review surfaced two problems: (a) those triggers are narrative, not mechanical, so an agent doesn't recognize the moment it should load them, and (b) `~/.claude/CLAUDE.md` plus the Claude Code system prompt already encode the same safety rubric at higher priority, so the context files were a third copy of guidance already loaded twice. Deleted in the trim commit; `context-authoring.md` was kept (it *does* have a real trigger — an agent literally adding or editing a leaf) and promoted out of `meta/` to `context/AUTHORING.md`. The now-empty `meta/` directory was removed.

## Known issues

None.

## Commands run

```bash
# Verify tree + line counts
find agent-workbench-live/context -name '*.md' | wc -l   # → 19 (after trim)
find agent-workbench-live/context -name '*.md' -exec wc -l {} +
# → README 59, every leaf ≤40

# Full suite
python -m unittest discover -s agent-workbench-live/tests -t agent-workbench-live
# → Ran 198 tests in 15.076s OK

# Targeted run
python -m unittest discover -s agent-workbench-live/tests -t agent-workbench-live -p test_context_library.py -v
# → Ran 5 tests in 0.004s OK
```

## Documentation touched

- `AGENTS.md` — added a "Context library" section and referenced the new `CLAUDE.md` under Related conventions.
- `agent-workbench-live/AGENTS.md` — added a "Context library" section above "Where to read more".
- `CLAUDE.md` — new file at the repo root wiring `@context/README.md` + `@context/AUTHORING.md`.
- `agent-workbench-live/.claude/commands/{plan,validate,start,followups,new-run}.md` — initially gained a single-line `Context:` import (commit `3214b68`); reverted in the follow-on commit. Net change on the branch: zero modifications to these five files.
- `docs/TODO.md` — will be updated during the docs-reconciliation step (delete §1, add ✅ summary, renumber).
- `docs/LOG.md` — will gain a dated 2026-05-22 entry.
