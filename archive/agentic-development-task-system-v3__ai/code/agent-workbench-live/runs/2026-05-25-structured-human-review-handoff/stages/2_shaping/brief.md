# Brief

## Goal

Pin a single structured shape for the workbench's `human_review` landing banner so that every CLI command that lands a run in `human_review` (today: `validate`, `followups`) prints the same body content in the same order. The banner is a pointer + minimum decision info — it tells the human where to read the canonical handoff document and what their three decision options do — and it deliberately does not duplicate fields that already live in the canonical HUMAN_REVIEW.md artifact (branch name, commit SHA, full file-by-file diff, test counts, per-artifact links, known-issues detail, run timeline).

## User-facing behavior

When a run transitions into `human_review` via either `validate` or `followups`, the CLI prints a `STOP.`-framed banner whose body has exactly five sections in this order:

1. `Review:` — one line, with the absolute filesystem path to the run's HUMAN_REVIEW.md.
2. `Summary of changes (≤3 bullets):` — up to 3 bullets sourced from HUMAN_REVIEW.md's `## Summary of changes` section. If the source has more than 3 bullets, a trailing line `…(<N> more in HUMAN_REVIEW.md)` is appended where N is the count of dropped bullets. Each bullet is single-line, truncated at ~100 columns with `…` if longer.
3. `Summary of testing (≤2 sentences, or "None recorded."):` — one or two sentences describing what was run (e.g. "unit tests"), pass/fail status as a boolean (no numeric counts), and whether a dogfood or manual run was recorded as a second sentence. If no testing was recorded for the run, the literal string `None recorded.` is printed instead.
4. `Diffstat:` — a single line summarizing total files changed and lines added/removed for the run's branch versus its base ref, formatted like `<N> files changed, +X / −Y lines`. If the diff cannot be resolved (no base ref SHA recorded and no usable base ref name), the literal line `unavailable (base_ref unresolved).` is printed instead.
5. `Next moves (human-triggered, type in a session):` — exactly three lines, one per terminal decision. Each line names a slash command and a short description of what it does. The three slash commands are `/complete <run-id>`, `/bounce <run-id>`, and `/abandon <run-id>`. No `agent-workbench ... --accepted-by ...` shell-form is shown.

The banner body is byte-for-byte identical regardless of which CLI command produced the landing — both `validate` and `followups` route through the same body builder when the landing state is `human_review`.

The existing `STOP.` frame and the static next-moves text for other landing states (e.g. `done`, `abandoned`, `ready`) are unchanged.

## Acceptance criteria

- Running the validate-equivalent CLI flow that lands a run in `human_review` produces a banner whose body sections appear in the order `Review:`, `Summary of changes:`, `Summary of testing:`, `Diffstat:`, `Next moves:` — no other sections, no missing sections.
- Running the followups-equivalent CLI flow that lands a run in `human_review` produces a banner body byte-identical to the one validate would produce for the same run.
- The `Review:` section prints an absolute (not relative) path to HUMAN_REVIEW.md for the landing run.
- The `Summary of changes:` section has at most 3 bullets. When the source HUMAN_REVIEW.md has 4 or more bullets, the literal line `…(<N> more in HUMAN_REVIEW.md)` follows the third bullet with N = (total − 3).
- Each `Summary of changes:` bullet is on a single line and truncated with a `…` suffix when its source exceeds ~100 columns.
- The `Summary of testing:` section has 1 sentence when tests are recorded but no manual/dogfood note exists, 2 sentences when a manual/dogfood note also exists, and the literal `None recorded.` string when no testing was recorded for the run. A would-be third sentence is dropped, not wrapped.
- The `Diffstat:` section prints `<N> files changed, +X / −Y lines` when the run's base ref is resolvable (either an explicit base-ref SHA recorded in the run's metadata, or a base-ref name git can resolve). When neither is resolvable, the literal `unavailable (base_ref unresolved).` is printed instead — never a misleading `0 files changed` for a non-empty run.
- The `Next moves:` section has exactly three lines, one each for `/complete`, `/bounce`, `/abandon`, each followed by a one-line description. No shell-form `agent-workbench …` invocations appear anywhere in the banner.
- The existing `cmd_validate.py` ad-hoc multi-paragraph block (commit SHA, test counts, per-artifact links, known-issues, …) inside the banner output is removed; those fields remain in HUMAN_REVIEW.md but not in the banner.
- The existing `cmd_followups.py` terse next-moves output is replaced by the full five-section body.
- Banner output remains ASCII-only — no color escapes, no Unicode line-drawing characters beyond what's already in the `STOP.` frame.
- Automated tests verify: (a) banner-body assembly for a fixture HUMAN_REVIEW.md with 2 bullets + tests passed + no manual testing, (b) 5 bullets + tests failed + manual dogfood recorded, (c) 0 bullets + no recorded testing; assert truncation, testing-line shape, and the `None recorded.` fallback. (d) snapshot test for the full banner across two existing fixture runs (`happy/`, `bounce_pass2/`) catches wording drift. (e) E2E extension after both `/followups` and staged `/validate` landings asserts presence of the absolute HUMAN_REVIEW.md path, exactly 3 `Next moves` decision lines, and either a diffstat line OR the "unavailable" fallback.

## Non-goals

- Adding PR links or GitHub integration to the banner.
- Loud-card / color / Unicode-art escape sequences (banner stays ASCII-only).
- A new banner shape for `done`, `abandoned`, or `ready` landings — those keep their existing static text. This task only pins the `human_review` body.
- Moving any field currently in HUMAN_REVIEW.md into the banner. Branch name, commit SHA, full file-by-file diff, per-artifact links, known-issues detail, test counts, and the run timeline stay in HUMAN_REVIEW.md and are explicitly NOT in the banner.
- Auto-opening HUMAN_REVIEW.md in the human's `$EDITOR` on landing — the human chooses when to read.
- Changing the `STOP.` frame itself (the `============` rules, the `STOP. State: human_review (human-owned).` line). The frame is fixed; this task pins the body content carried inside it.
- Changing the HUMAN_REVIEW.md renderer or template — they're already correct.

## Good examples

**Body for a run with 2 changes, tests passing, no manual testing recorded:**

```
Review:
  HUMAN_REVIEW.md: /Users/me/GitHub/LOCAL_worktrees/awb-2026-05-25-structured-human-review-handoff/agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/HUMAN_REVIEW.md

Summary of changes (≤3 bullets):
  - Added _build_human_review_body() that assembles the five-section body from metadata + HUMAN_REVIEW.md.
  - Updated cmd_validate and cmd_followups to route through the new builder.

Summary of testing (≤2 sentences, or "None recorded."):
  Unit tests passed; no known issues.

Diffstat:
  4 files changed, +152 / −38 lines

Next moves (human-triggered, type in a session):
  /complete <run-id>  — accept; auto-merges worktree branch into parent
  /bounce <run-id>    — send back to building with structured feedback
  /abandon <run-id>   — discard the run
```

**Body for a run with 5 changes (truncated to 3), tests failed, dogfood run recorded:**

```
Review:
  HUMAN_REVIEW.md: <absolute path>

Summary of changes (≤3 bullets):
  - Bullet one.
  - Bullet two.
  - Bullet three.
  …(2 more in HUMAN_REVIEW.md)

Summary of testing (≤2 sentences, or "None recorded."):
  Unit tests failed (see HUMAN_REVIEW.md). A dogfood run was recorded.

Diffstat:
  unavailable (base_ref unresolved).

Next moves (human-triggered, type in a session):
  /complete <run-id>  — accept; auto-merges worktree branch into parent
  /bounce <run-id>    — send back to building with structured feedback
  /abandon <run-id>   — discard the run
```

**Body for a run with no recorded testing and no changes summarized:**

```
Review:
  HUMAN_REVIEW.md: <absolute path>

Summary of changes (≤3 bullets):
  (none recorded)

Summary of testing (≤2 sentences, or "None recorded."):
  None recorded.

Diffstat:
  0 files changed, +0 / −0 lines

Next moves (human-triggered, type in a session):
  /complete <run-id>  — accept; auto-merges worktree branch into parent
  /bounce <run-id>    — send back to building with structured feedback
  /abandon <run-id>   — discard the run
```

## Bad examples

- A banner that interpolates the full commit SHA, file-by-file diff, or per-artifact link list — those belong in HUMAN_REVIEW.md, not here.
- A `Next moves:` section that prints `agent-workbench complete <run-id> --accepted-by <name>` or any other shell-form — the human types decisions as slash commands in a session, not at a terminal.
- A `Summary of changes:` section with 4+ bullets — even when the source has more, the cap is 3 + a `…(N more)` tail.
- A `Summary of testing:` section that wraps to a third sentence — the renderer truncates at 2 sentences and drops the rest.
- A `Diffstat:` section that prints `0 files changed, +0 / −0 lines` for a run whose base ref couldn't be resolved — that's misleading; the correct output is `unavailable (base_ref unresolved).`.
- A banner whose body differs between `validate` and `followups` for the same run — both must produce the byte-identical body.
- A banner that uses color escape sequences or Unicode line-drawing characters beyond the existing `STOP.` frame.

## Constraints

- Banner output is ASCII-only.
- Implementation lives in the single helper module the existing `STOP.` frame ships from. Both `validate` and `followups` route through it for the body — no duplicated wording in either command's source.
- The `Diffstat:` line uses git-shortstat-equivalent output computed inside the run's worktree against either an explicit base-ref SHA from the run's metadata or the configured base-ref name.
- The `Summary of changes:` bullets are sourced from HUMAN_REVIEW.md (the canonical artifact), not re-derived from build artifacts or git data. If the canonical document does not have a `## Summary of changes` section or it is empty, the body renders `(none recorded)` rather than failing.
- The `Summary of testing:` line is sourced from the run's QA report fields — pass/fail and known-issue count for the first sentence; a recorded dogfood/manual run for the optional second sentence. No raw test counts appear.
- The truncation rules (≤3 bullets, ≤100 columns per bullet, ≤2 sentences) are enforced by the renderer, not by upstream content discipline.
- No new top-level CLI flags or commands are introduced.
- No changes to metadata.yaml schema, the lifecycle state machine, the HUMAN_REVIEW.md renderer, or the HUMAN_REVIEW.md template.

## Assumptions

- HUMAN_REVIEW.md already exists and is up-to-date by the time the banner is rendered. Both `validate` and `followups` render it (or refresh it) before they print the `STOP.` banner today; this task does not change that ordering.
- The run's metadata already carries (or can derive) enough information to resolve a base ref for the diffstat — either an explicit base-ref SHA field (added by an earlier run, `303bd40`) or the configured base-ref name. The renderer falls back to "unavailable" when neither is resolvable.
- The QA report's fields used by the testing line (`tests_passed`, `known_issues_count`, plus any recorded manual/dogfood mention) are already populated by the time the banner is rendered.
- The run is executing inside a worktree by the time it can land in `human_review`. The diffstat is computed inside that worktree.
- The set of three terminal decisions (`/complete`, `/bounce`, `/abandon`) is the entire set of valid moves from `human_review`. No fourth move exists today; this banner reflects that.

## Suggested QA scenarios

1. Land a fresh run in `human_review` via `validate` with 2 changes, tests passing, no manual testing recorded. Confirm: 5 sections in order; absolute HUMAN_REVIEW.md path; exactly 2 bullets, no `…(N more)` tail; testing line is the single sentence form; diffstat is a real `N files changed, +X / −Y lines`; exactly 3 `Next moves` lines; no `agent-workbench` shell-form anywhere.
2. Land a fresh run in `human_review` via `followups` (i.e. a follow-ups-only landing, no validate). Confirm the banner body is byte-identical to scenario 1 for an equivalent set of artifacts.
3. Land a run whose HUMAN_REVIEW.md has 5 bullets in the changes section. Confirm exactly 3 bullets are printed, followed by `…(2 more in HUMAN_REVIEW.md)`.
4. Land a run whose HUMAN_REVIEW.md has 0 bullets (or no `## Summary of changes` section). Confirm `(none recorded)` is printed, no crash.
5. Land a run with tests failing AND a recorded dogfood/manual run. Confirm the testing line has 2 sentences: pass/fail first, dogfood mention second.
6. Land a run with no QA report recorded. Confirm `Summary of testing:` is the literal `None recorded.` string.
7. Land a run where the base-ref SHA is missing from metadata AND the base-ref name does not resolve (e.g. a synthetic test run). Confirm `Diffstat: unavailable (base_ref unresolved).` — not `0 files changed`.
8. Land a run where the diffstat is genuinely empty (HEAD == base ref SHA, but the SHA does resolve). Confirm the renderer can distinguish "resolvable but empty" (prints `0 files changed, +0 / −0 lines`) from "unresolvable" (prints the fallback). This boundary is the high-value one.
9. Confirm the banner contains no color escape sequences (`\x1b[`) and no Unicode line-drawing characters beyond what the `STOP.` frame already uses.
10. Snapshot-test the full banner across two existing fixture runs (`happy/`, `bounce_pass2/`) to catch any wording drift across the two call sites.
