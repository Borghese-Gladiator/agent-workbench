# Dogfood the §2 board card attributes

Drive a tiny throwaway run through the lifecycle so the live board's new
card attributes (scope badge, `● live` flag, AC coverage, diff stats,
followups categories, accepted_by, etc.) all render against a real run.

Scope is `repair` so the rendered card differs from the existing
`bootstrap` (Shogi) and `implementation` runs already in the workbench —
the reviewer can verify the scope tag changes by state, not by accident.

Acceptance criteria

1. `new-run` lands the card in `draft` with `[draft] repair`.
2. `shape` / `plan` carry it through `shaping` and `planning`.
3. `start` creates the worktree and lands in `building`.
4. A trivial commit on the worktree exercises the `+A/-R across F files`
   diff line.
5. `validate` runs and lands the card in `human_review` after producing
   review.md + qa/report.md + audit.md.
6. `followups` records at least one entry so `follow-ups: N` and the
   per-category breakdown both render.
7. `complete` moves the card to `done` with `accepted_by tim · HH:MM`.
