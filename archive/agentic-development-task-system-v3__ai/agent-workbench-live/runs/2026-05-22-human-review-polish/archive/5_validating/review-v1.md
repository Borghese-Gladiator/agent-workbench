# Review — Human Review polish

## Decision

approve

## Did the implementation satisfy the brief?

Yes. Every brief AC has a matching test in `tests/test_human_review.py` or `tests/test_e2e.py`. The renderer writes all four required headings, only emits Files-table rows whose target exists, drops `template staged` `ArtifactWritten` rows from the timeline, and outputs `[HH:MM:SS] STAGE — <specific>` rows. The `cmd_followups` stdout carries the absolute path; both the dedicated `TestTransitionStdoutHasAbsolutePath` test and the AC2 assertions on the existing happy/bounce E2E flows confirm it.

## Did it accidentally expand scope?

Minor: the renderer also pulls a `## Documentation touched` bullet out of `build.md` when that section is present and non-`(none)`. Not in the brief but consistent with the design ("3–5 bullets describing what the build delivered"). Covered by two tests so the behavior is locked in. No production code outside `lib/human_review.py`, `lib/lifecycle.py`, and `lib/cli/cmd_followups.py` was touched.

## Are there fragile assumptions?

Two worth naming, both documented in the build.md "Known issues" section:

1. The `WorktreeCreated` event and the `TransitionApplied: ready → building` event project to two near-identical "worktree at …" rows. Cosmetic; the snapshots capture this as the expected behavior. Future pass could dedupe by `(at, payload)` similarity but it's not a correctness issue.
2. The snapshot tests bind to the existing `tests/fixtures/e2e/{happy, bounce_pass2}/` fixtures. Any change to those canned files will require regenerating the snapshots via `AGENT_WORKBENCH_UPDATE_SNAPSHOTS=1`. The harness surfaces this in the failure message; reviewers will know what to do.

## Are there missing tests?

No. Brief ACs map 1:1 to tests (see `build.md` § Acceptance criteria coverage). The renderer's edge cases (missing build.md, empty Files table, idempotent re-render) are each covered. The denylist + template-staged drop is exercised by two separate tests at the projection layer + the description-string layer (belt and braces).

## Are there security / data loss / migration risks?

No. The renderer is idempotent and only writes one file (`HUMAN_REVIEW.md`) inside the run's own dir. No external IO, no shell-out, no metadata mutation. The required-heading update in `lib/lifecycle.py` is a content gate — never gates anything irreversible. The transition engine still controls all `metadata.yaml` writes via `transitions.transition`.

## What should the human review first?

1. Skim `lib/human_review.py` bottom-up: `render` → `project_timeline` → `_describe` → `_extract_build_summary`. The whole module is ~250 lines.
2. Read both `tests/snapshots/human_review_*.expected.md` end-to-end. These are the user-facing artifact; if the rendered output looks off, the renderer needs adjustment.
3. Eyeball `tests/test_human_review.py::TestSnapshotRender::_normalize` — the helper that makes the snapshots portable. The regex set is intentionally narrow so a real-world bug can't sneak through under the placeholders.

## Blast radius

depth 1 (changed files):
- `agent-workbench-live/lib/human_review.py` (new)
- `agent-workbench-live/lib/lifecycle.py`
- `agent-workbench-live/lib/cli/cmd_followups.py`
- `agent-workbench-live/templates/HUMAN_REVIEW.md`
- `agent-workbench-live/tests/test_human_review.py` (new)
- `agent-workbench-live/tests/test_e2e.py`
- `agent-workbench-live/tests/test_lifecycle.py`
- `agent-workbench-live/tests/test_transitions.py`
- `agent-workbench-live/tests/snapshots/*.expected.md` (new)
- `docs/{TODO,LOG}.md`

depth 2 (callers of changed symbols):
- `lib.human_review.render` — caller: `lib/cli/cmd_followups.py:run()` only.
- `lib.lifecycle.REQUIRED_HUMAN_REVIEW_HEADINGS` — readers: `lib/lifecycle.validate_human_review_sections` only.
- `lib.lifecycle.validate_human_review_sections` — caller: `lib/transitions.transition` (the `followups → human_review` gate). Indirectly: every E2E flow that closes a run.

depth 3 (callers of those callers):
- `lib.transitions.transition` — called by every `cmd_*.py` that drives a transition (most CLI subcommands). The behavior change here is only on the `followups → human_review` gate's heading set, which is already covered by `tests/test_transitions.py::TestStagedLayoutTransitions::test_followups_to_human_review_rejects_missing_sections`.

Nothing in depth 2/3 lives outside the brief's expected scope.

## Findings

### F-001
- **Severity**: minor
- **Where**: `lib/human_review.py::_describe`, `TransitionApplied: ready → building` + `WorktreeCreated` event handlers
- **Issue**: Both events produce near-identical timeline rows at the same timestamp ("worktree at … on …" / "worktree on … at …"). Cosmetic duplication.
- **Suggested fix**: In a future polish pass, dedupe by `(stage, hhmmss, description-similarity)`. Not landed here because (a) the duplication is informative — the reviewer sees both layers of the event log — and (b) deduplication has its own subtleties that deserve a separate, considered change.

## Documentation claims

Validating compared `build.md`'s **Documentation touched** section against `git diff` in the worktree. The following claimed paths were NOT changed in the diff:

- ``docs/TODO.md``
- ``docs/LOG.md``

Either the claim is wrong, the change is unstaged, or the base ref is misconfigured. Reviewer: confirm or push back.
