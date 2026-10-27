---
description: Open the live Agent Workbench TUI — a full-screen Kanban over runs/ that auto-refreshes as files change. Use when the user wants an always-on view of what every run is doing right now.
---

# /board

Launches `agent-workbench board` — a Textual TUI that renders every run as a card grouped into a Kanban by lifecycle state. The board re-reads `runs/<id>/metadata.yaml` and `events.jsonl` on every filesystem change (via `watchdog`) plus a 1Hz fallback timer, so the visible state is always what's on disk right now.

```bash
agent-workbench board                     # live TUI; q quits
agent-workbench board --all               # include done + abandoned
agent-workbench board --status building
agent-workbench board --compact           # one-liner cards (narrow terminals)
agent-workbench board --static            # one-shot stdlib-only text dump
```

## Card content (status-aware)

The title line shows `run_id`, the lifecycle state badge, `scope.kind`, and a `● live` marker when any event fired in the last minute. Underneath: age since `updated_at`, repo name, repo path tail (when distinct), and branch. The body changes by lifecycle state:

- `building` — `build.iterations / max_iterations` with a progress bar; `avg <N>/iter` derived from `TransitionApplied → building` gaps; `↩ bounced from <state> · <age> ago` when the run re-entered `building` from human review; `+A/-R across F files` diff against `target.repo.base_ref`; recent bounce reason; "builder gave up" flag.
- `validating` — `tests ✓/✗/?` with the age of the last `QACompleted` event, `rev ✓/·`, `qa ✓/·`; `X/Y ACs covered` parsed from the `## Acceptance criteria coverage` table in `stages/4_building/build.md` (or `AC table missing` when absent); known-issues count; diff stats.
- `followups` — entries count + per-category breakdown derived from `FollowupsRecorded.categories`.
- `human_review` — `! stale <age>` if the run has sat in this state longer than `board.stale_human_review_hours` (default 24h); bounce count; follow-ups count.
- `done` — `accepted_by <name> · <HH:MM>`.
- `abandoned` — `abandoned: <reason>`.

A soft `! worktree missing` warning shows whenever `target.worktree.created` is false and the run is past `ready`.

Every card lists the last 3 events from `events.jsonl` so a moving run is visually moving.

## Loud cards

A card is "loud" (red border + `!` prefix + a `!` marker on its column header) when any of:

- `human_review` and stale.
- `build.exit_reason == max_iterations`.
- `validation.tests_passed == false`.
- `validation.known_issues_count > 0`.
- An `ErrorRecorded` event after the last `TransitionApplied`.

## Requirements

The live board needs `textual` and `watchdog`:

```bash
pip install -r requirements-board.txt
```

If they're missing, `agent-workbench board` exits with an install hint. `agent-workbench board --static` always works (stdlib only) and is the right choice for CI / headless / piping.

## Out of scope

Read-only — `q` quits, no other keystrokes. Mutate state via the lifecycle CLI / slash commands in another pane.
