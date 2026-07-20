# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes. All eight metrics from the brief's acceptance criteria are computed and surfaced through the new CLI. The lifecycle hook fires at every required transition (after `/validate`, at `complete`, at `abandon`). The HUMAN_REVIEW.md block and the board card band are both in place. Tracking is measurement-only — no budgets, no thresholds, no severity styling on the board band.

## Did it accidentally expand scope?

No. Touched only the planned files plus `.gitignore` (small + necessary for the derived caches). No changes to `metadata.yaml` schema, no new event types in `schemas/events.jsonl`, no changes to the existing slash-command bodies. Templates dir unchanged — the HUMAN_REVIEW block is injected post-template-stage at the `followups -> human_review` boundary, not authored into the template itself.

## Are there fragile assumptions?

Three, all documented in plan.md's ASM-001 / ASM-002 / ASM-003.

- The transcript slug derivation (`/` → `-`, `_` → `-`, `.` → `-`) matches Claude Code's convention as observed in `~/.claude/projects/`. If the convention changes upstream, `find_transcripts()` returns `[]` and the writer falls back to writing a `notice` row in `metrics.jsonl` rather than crashing. Detectable but not auto-self-healing.
- Bucket attribution is a regex heuristic against text markers (`Contents of /Users/.../CLAUDE.md`, `<command-name>`, `@context/...`). When these markers drift, more bytes fall into `other`. The plan calls out tracking the `other` fraction as a quality signal — that follow-up is not yet wired.
- The 4-chars-per-token estimate in `buckets.py` is a constant; real tokenization varies by content. The scaling step at the end of `attribute()` lifts the total back to the transcript's authoritative `input_tokens`, so the *total* is exact even when per-bucket estimates drift.

## Are there missing tests?

The E2E happy / bounce_pass2 fixture snapshot tests called for in the brief were deferred (see build.md "Deviations"). Rationale: the existing fixtures don't carry realistic transcript JSONL — snapshotting them would test only the writer's behavior on synthetic input, which is already covered by `test_metrics_writer.py`. A follow-up captures this as a candidate improvement.

Otherwise: 50 new tests across 7 files cover transcript correlation (window, cwd, command markers), bucket attribution (every bucket + sum invariant), price validation (every malformed shape), line counting (with/without merge), summary derivation (all 8 metrics, repair-token edge cases), writer integration (full path + idempotency), and CLI smoke (4 forms).

## Are there security / data loss / migration risks?

No security risk. The writer reads from `~/.claude/projects/*.jsonl` (the user's own transcripts) and writes only inside the run directory + the workbench's `metrics/` dir. No network calls. No new file deletions; the writer overwrites `metrics.jsonl` atomically via `.tmp` rename.

No migration risk. New on-disk artifacts (`metrics.jsonl`, `metrics-summary.json`, `metrics/index.json`) are additive. Old runs without these files render fine in the board (the metrics band conditionally hides), and the CLI fails clearly when given a run-id with no metrics file.

## What should the human review first?

1. `lib/metrics/transcript.py:correlate()` — the slash-command tracking loop. Verify the "command begins on this user message, ends on the next" model matches what we observe in real transcripts.
2. `lib/metrics/buckets.py:attribute()` — the scaling logic. The invariant is that per-bucket counts sum to the turn's `input_tokens`; verify this holds for the edge cases (no text, all text, overlap between markers).
3. `lib/metrics/summary.py:_compute_repair_tokens()` — the "tokens after the first non-approve" heuristic. Confirm this matches the brief's "repair = total minus first happy-path tokens" definition.
4. `lib/cli/cmd_followups.py:_inject_metrics_block()` — the HUMAN_REVIEW.md injection. Confirm idempotency (re-running replaces the block, doesn't append a second one).
5. The new band in `lib/board/app.py:_card_text()` (around line 180) — confirm it only renders when `run.metrics_total_tokens is not None`.

## Blast radius

depth 1 (changed files):
  agent-workbench-live/bin/agent-workbench
  agent-workbench-live/lib/board/app.py
  agent-workbench-live/lib/board/source.py
  agent-workbench-live/lib/cli/cmd_abandon.py
  agent-workbench-live/lib/cli/cmd_complete.py
  agent-workbench-live/lib/cli/cmd_followups.py
  agent-workbench-live/lib/cli/cmd_metrics.py (new)
  agent-workbench-live/lib/cli/cmd_validate.py
  agent-workbench-live/lib/metrics/*.py (all new)
  agent-workbench-live/metrics/prices.yaml (new)
  agent-workbench-live/tests/test_cmd_board.py
  agent-workbench-live/tests/test_*metrics*.py (all new)
  agent-workbench-live/.gitignore

depth 2 (callers of changed symbols):
  RunSnapshot      -> lib/board/app.py (_card_text), tests/test_cmd_board.py
  load_run_snapshot -> lib/board/snapshot.py (build_board_state), lib/cli/cmd_board.py
  record_run_metrics -> lib/cli/cmd_validate.py, cmd_complete.py, cmd_abandon.py, cmd_followups.py, cmd_metrics.py
  summarize         -> lib/cli/cmd_metrics.py, lib/cli/cmd_followups.py, lib/metrics/rollup.py

depth 3 (callers of those callers):
  build_board_state -> lib/board/app.py event loop (TUI render)
  cmd_metrics.run   -> bin/agent-workbench dispatcher

Nothing in depth 2/3 lives outside the brief's expected scope. The board read path is the deepest reach (it now reads metrics.jsonl on every snapshot build), but the read is gated on `metrics_path.exists()` and falls back cheaply to `_quick_metrics_from_jsonl` rather than recomputing the full summary.

## Findings

### F-001
- **Severity**: minor
- **Where**: `lib/metrics/buckets.py` _classify_user_text
- **Issue**: The CLAUDE.md block boundary heuristic uses a regex against "Contents of " and "# currentDate" markers. If a user message legitimately contains the substring "Contents of /Users/..." (e.g., quoting another message), the bucketer will over-count `claude_md_and_agents_md`. The scaling step at the end rescues the total, but the bucket distribution gets noisier.
- **Suggested fix**: Detection of the CLAUDE.md block could be hardened by also checking for the "Contents of /Users/.../CLAUDE.md (user's private global instructions" preamble specifically. Deferred to a follow-up — current behavior is honest (it over-attributes to a real bucket rather than to `other`) and the scaling step preserves the sum invariant.

### F-002
- **Severity**: minor
- **Where**: `lib/metrics/lines.py` count_generated
- **Issue**: The function adds `+` lines from `git log <base>..HEAD` to the artifact-event lines, but these may double-count when an event records the writing of a file that is also committed to the worktree (e.g., a `.md` doc file). In practice the artifact events are for run-stage files (brief.md, plan.md, etc) which live in the run dir not the worktree, so the overlap is zero today, but a future change that writes worktree files via events would break this.
- **Suggested fix**: When summing artifact-event lines, filter to events whose payload `path` is *not* inside the worktree. Deferred — the current event taxonomy never writes worktree files via `ArtifactWritten`.

### F-003
- **Severity**: minor
- **Where**: `lib/cli/cmd_followups.py` _inject_metrics_block
- **Issue**: The block is appended at the end of HUMAN_REVIEW.md, after any "Suggested first checks" / "Run timeline" sections. Per TODO §2 (Human Review polish), these sections are slated for replacement. When that work lands, the block's relative position may shift.
- **Suggested fix**: Coordinate with TODO §2 work. For now, the position is acceptable because the section ordering is not load-bearing.
