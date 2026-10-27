## 2. Structured human_review handoff output

Discovered 2026-05-24 while reviewing the CLI's human_review landing output. The `STOP.` banner (shipped in `9eda554`, `lib/cli/_stop_banner.py`) lands the agent's attention, but the *content* the banner carries is currently inconsistent across call sites: `cmd_followups.py` prints a terse "Next moves" command list with no summary; `cmd_validate.py` (the dogfood example) prints a hand-typed multi-paragraph block with commit SHA, test counts, and per-artifact links inline. Same lifecycle event, two very different shapes. The agent — and the human reading the agent's tool output — has to re-derive what's load-bearing each time. This task pins a single structured shape.

### Design principles

- **Banner is a pointer + minimum decision info; HUMAN_REVIEW.md is canonical.** The banner exists so the human can decide *whether to open HUMAN_REVIEW.md* (or which of `/complete`/`/bounce`/`/abandon` to type without opening anything). Anything that belongs in HUMAN_REVIEW.md (branch, commit SHA, full file-by-file diff, test result counts, per-artifact links, known issues, run timeline) does NOT belong in the banner. The renderer in `lib/human_review.py` already produces all of that — the banner must not duplicate it.
- **Worktree paths are not memorizable.** Each run lives in a worktree under `~/GitHub/LOCAL_worktrees/...` with a date-and-slug name the human did not pick. The banner MUST print the absolute path to HUMAN_REVIEW.md so the human can open it without re-deriving the worktree directory.
- **Decision text, not commands.** The "next moves" lines are reminders, not copy-pasteable CLI invocations. The human types the decision in a Claude Code session, not at a shell. Drop the `agent-workbench complete <run-id> --accepted-by ...` form; keep one-line descriptions of what each decision *does*.
- **One source of truth for the banner content shape.** Same helper drives every agent-stopping transition's banner content (`lib/cli/_stop_banner.py` pins the *frame*; this task pins the *body* for `human_review` landings specifically). Wording stays in sync across `cmd_validate.py` and `cmd_followups.py`.
- **Conciseness is enforced.** ≤3 bullets in Summary of changes; ≤2 sentences in Summary of testing. Hard caps so it doesn't sprawl back into the bad-example shape. The renderer truncates rather than wraps.

### Banner shape for `human_review` landings

```
============================================================
STOP. State: human_review (human-owned).

Review:
  HUMAN_REVIEW.md: <absolute path to runs/<id>/HUMAN_REVIEW.md>

Summary of changes (≤3 bullets):
  - <bullet 1>
  - <bullet 2>
  - <bullet 3>

Summary of testing (≤2 sentences, or "None recorded."):
  <one to two sentences on what was run to confirm behavior — unit, dogfood, manual, etc.>

Diffstat:
  <N files changed, +X / −Y lines>

Next moves (human-triggered, type in a session):
  /complete <run-id>  — accept; auto-merges worktree branch into parent
  /bounce <run-id>    — send back to building with structured feedback
  /abandon <run-id>   — discard the run
============================================================
```

Where the body fields come from:

| Field | Source |
|---|---|
| HUMAN_REVIEW.md path | `metadata.run_dir(cfg, run_id) / "HUMAN_REVIEW.md"`, absolute. |
| Summary of changes | First ≤3 bullets from HUMAN_REVIEW.md's `## Summary of changes` section. Code-derived (already populated by `lib/human_review.py`'s renderer). If more bullets exist, truncate with a trailing `…(N more in HUMAN_REVIEW.md)`. |
| Summary of testing | One sentence built from `lib/metrics/lines.py` / QA report — names what was run (e.g. "unit tests"), pass/fail status (boolean — no counts), and whether a dogfood/manual run was recorded. If none recorded, the line is literally `None recorded.` |
| Diffstat | `git diff --shortstat <base_ref_sha>..HEAD` inside the worktree, formatted into the single line shown. (Uses the `metadata.target.repo.base_ref_sha` field added in `303bd40`.) |
| Next moves | Static — one line per terminal action, with text descriptions, not full CLI commands. |

### Tasks

- [ ] **Extend `lib/cli/_stop_banner.py` with a `human_review` body builder.** That helper currently maps landing state → static next-moves text. Add a sibling function `_build_human_review_body(cfg, run_id) -> str` that reads HUMAN_REVIEW.md, extracts the first ≤3 `## Summary of changes` bullets, builds the testing line from the QA report's outcome (`tests_passed: true` + `known_issues_count: 0` → "Unit tests passed; no known issues."; `false` → "Unit tests failed (see HUMAN_REVIEW.md)."; manual/dogfood mentions get a second sentence), and runs `git diff --shortstat` inside the worktree. `print_stop_banner(landing_state="human_review", run_id=...)` calls this builder; other landing states keep the current static text.
- [ ] **Truncation discipline.** The summary-of-changes extractor caps at 3 bullets. If HUMAN_REVIEW.md has more, append the literal line `  …(<N> more in HUMAN_REVIEW.md)`. Each bullet is single-line truncated at ~100 columns with `…` if longer. The testing line is capped at 2 sentences; if the renderer would produce a third, it's dropped.
- [ ] **Decision text replaces command text.** Rewrite the existing `Next moves` block — both in `cmd_followups.py`'s current output and in `cmd_validate.py`'s ad-hoc block — to the three-line form shown above (`/complete <run-id>`, `/bounce <run-id>`, `/abandon <run-id>`, each with a short description). Remove the `agent-workbench complete ... --accepted-by ...` shell form entirely.
- [ ] **Diffstat fallback.** If `base_ref_sha` is missing (pre-`303bd40` runs), fall back to `git diff --shortstat <base_ref>..HEAD`. If that's empty (e.g. `HEAD..HEAD`), print `Diffstat: unavailable (base_ref unresolved).` rather than a misleading "0 files changed."
- [ ] **Verify HUMAN_REVIEW.md owns the canonical fields.** Sanity-check that branch name, commit SHA, full file-by-file diff, per-artifact links (brief / plan / build / QA / review / audit), and known-issues detail are all already in `lib/human_review.py`'s renderer output and the `templates/HUMAN_REVIEW.md` heading contract. They are today (verified 2026-05-24 against `runs/2026-05-24-fix-generated-lines-base-ref-head/HUMAN_REVIEW.md`); this task does not move them, only confirms the banner doesn't need to carry them.
- [ ] **Tests.**
  - Unit test for `_build_human_review_body`: fixture HUMAN_REVIEW.md files with (a) 2 bullets + tests passed + no manual testing, (b) 5 bullets + tests failed + manual dogfood recorded, (c) 0 bullets + no recorded testing. Assert truncation, testing-line shape, and the `None recorded.` fallback.
  - Snapshot test for the full `human_review` banner across two fixture runs (`happy/` and `bounce_pass2/` from the existing E2E set). Catches wording drift.
  - E2E extension: after `/followups` and after staged `/validate` lands in `human_review`, assert the stdout contains the absolute HUMAN_REVIEW.md path, exactly 3 `Next moves` decision lines, and either a diffstat line OR the "unavailable" fallback.

### Acceptance

- Running `/followups <id>` or `/validate <id>` (when either lands at `human_review`) prints a banner whose body has exactly the five sections in the order shown: `Review:`, `Summary of changes:`, `Summary of testing:`, `Diffstat:`, `Next moves:`.
- The `Review:` section prints the absolute path to HUMAN_REVIEW.md.
- The `Summary of changes:` section has ≤3 bullets, with a `…(N more)` line if HUMAN_REVIEW.md had more.
- The `Summary of testing:` section has ≤2 sentences, or the literal string `None recorded.` when no testing was recorded.
- The `Next moves:` section has exactly three lines: `/complete`, `/bounce`, `/abandon` — each with a one-line description, no `agent-workbench` shell form.
- Banner body is identical regardless of which CLI command produced the landing (driven by the single helper).
- HUMAN_REVIEW.md remains the canonical artifact for branch, commit SHA, full diff, test result counts, per-artifact links, known issues, and run timeline. The banner does not duplicate any of these.

### Non-goals

PR links (no support yet — out of scope until the workbench grows GitHub integration). Loud-card / color escape sequences (banner stays ASCII-only, per `_stop_banner.py`). A banner shape for `done` / `abandoned` landings (those are terminals — the existing static text in `_stop_banner.py` is enough). A banner shape for `ready` (planning landing — different decision set, different shape, separate task). Moving any field currently in HUMAN_REVIEW.md into the banner. Auto-opening the file in `$EDITOR` on landing (the human chooses when to read).

### Origin

Surfaced 2026-05-24 during a session reviewing the CLI's `human_review` landing output across the stop-banner dogfood run (`9eda554`) and the prior fix-generated-lines run. The two runs printed structurally different "what to review / what to decide" content for the same lifecycle event. The user pinned the rule: banner = pointer + minimum decision info; HUMAN_REVIEW.md = canonical detail.
