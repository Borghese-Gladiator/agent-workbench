# Fleet status — agent-legible task monitoring

## Brief

Monitoring many concurrent tasks is hard today. `awb task list` is a flat repo/prompt/phase/condition
table; `--state` does an N+1 Temporal query per task. The rich signals a human or an LLM actually needs —
"what is it working on right now", "did it bounce back to QA / get rejected", "how many open findings",
"is there a draft PR" — all exist in SQLite (`phase_attempts.attemptNumber`/`outcome`,
`semantic_events.summary`, `findings`, `pull_requests`) but nothing composes them for the whole fleet in
one call. The primary consumer is an **LLM agent harness** monitoring a run, not a human's eyes, so the
load-bearing deliverable is a single one-shot, deterministic, token-cheap status view — not a blinking
TUI. The TUI is a thin human wrapper over the same composed data.

## Approach — three layers over one composer

- **Layer 1 — composer + endpoint.** `getFleetStatus(db)` in `@awb/database` builds a `FleetTaskRow[]`
  from SQLite in one pass (no per-task Temporal query). `GET /api/tasks/fleet` serves it.
- **Layer 2 — `awb fleet` CLI.** One-shot renderer. Default = aligned human table on a TTY; `--md` =
  markdown table (the agent-legible default an LLM pastes into reasoning); `--json` = stable
  named-field contract. This is what Claude Code calls to monitor tasks.
- **Layer 3 — `awb fleet --watch` TUI.** Re-renders Layer 1 on an interval for humans. Same composer,
  so it can never drift from what the agent sees.

## Composed FleetTaskRow

- `taskId`, `repositoryName`, `promptLine` (first line, truncated)
- `phase`, `condition`, `deliveryState`, `size`
- `attempt` (attemptNumber of current phase), `bouncedFrom` (phase the run regressed from, if any),
  `lastOutcome` (prior attempt outcome text)
- `activity` (latest semantic-event summary), `activityAgeSec`, `activityType`
- `openFindings` (count), `topFinding` (first open finding description + severity)
- `pr` ({ number, url, isDraft } | null)
- `parentTaskId` (stacking edge), `updatedAt`

## Bounce detection

`phase_attempts` rows are keyed (run, phase, attemptNumber). The current phase's max attemptNumber > 1
means it retried in place. A regression ("back to QA / implement") is detected when a phase *earlier in
`TASK_PHASE_ORDER` than the max phase ever reached* has its latest attempt started after some later
phase's attempt — i.e. the run moved backward. `bouncedFrom` = the furthest phase reached; shown as
`#N ↩<phase>` when current phase-order < max phase-order reached.

## Tests

### Unit
- `getFleetStatus`: composes attempt/activity/findings/PR for a seeded task; N tasks in one call.
- bounce detection: seed phase_attempts implement→qa→implement, assert `bouncedFrom: 'qa'`, attempt 2.
- empty findings / no events / no PR → null-safe fields.
- CLI render: table, `--md`, `--json` snapshot for a fixed row set (deterministic ordering).

### Manual
- Boot pinned stack in this worktree, run `awb fleet`, `awb fleet --md`, `awb fleet --json` against the
  live 8 tasks. Confirm activity + attempt columns populate.
- `awb fleet --watch` renders and refreshes; Ctrl-C exits cleanly.
