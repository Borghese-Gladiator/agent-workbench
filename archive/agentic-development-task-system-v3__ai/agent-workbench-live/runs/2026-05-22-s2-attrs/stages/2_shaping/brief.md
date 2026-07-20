# Brief

## Goal

Add a tiny `version.txt` file to the throwaway repo so the §2 dogfood run
exercises every new live-board card field. The work itself is trivial;
the value is observing the live board surface each new attribute as the
card moves between columns.

## User-facing behavior

A `version.txt` file appears at the repo root containing `0.0.1`. That's
the entire user-visible change. The real "user" of this dogfood is the
human watching the board — they should see the new card body fields
(`[building] repair`, `live` flag, `+A/-R across F files` diff, `1/1
ACs covered`, `accepted_by · HH:MM`, etc.) update as the run progresses.

## Acceptance criteria

1. `version.txt` exists at repo root.
2. `version.txt` contents == `0.0.1` (with trailing newline).
3. `python -m pytest` doesn't apply — the repo has no tests. QA records
    a manual pass.

## Non-goals

Anything beyond writing `version.txt`. No CI, no packaging, no test
scaffolding. The board is the feature under test, not this repo.

## Good examples

Other one-line version-file conventions in unrelated repos.

## Bad examples

Anything that imports a library, adds a Makefile, or generates a
changelog. Scope is one file, one string.

## Constraints

None.

## Assumptions

The dogfood is observed live — a human is watching the board in another
pane while these commands execute.
