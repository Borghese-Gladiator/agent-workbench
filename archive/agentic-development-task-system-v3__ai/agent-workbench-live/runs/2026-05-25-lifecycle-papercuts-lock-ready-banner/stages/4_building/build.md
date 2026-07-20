# Build report

<!--
Single file produced by the builder during `building`. Replaces the older
implementation-summary.md + diff-summary.md pair for staged runs (TODO §1b).
The transition engine moves this file to stages/4_building/build.md when
the stage closes.
-->

## What changed

<!-- 1–3 sentence narrative: what was actually implemented and why. -->

## Files changed

<!--
Inventory of files added / modified / deleted. One bullet per file. Don't
duplicate the diff; capture intent.
-->

## Reviewer reading order

<!--
3–7 files in the order a reviewer should read them. Each line includes a
one-line "what to look for here". Without this section the Files changed list
is just an inventory.
-->

## Acceptance criteria coverage

<!--
Every AC from the brief mapped to a test path or an explicit "not tested —
because …" justification. Transition out of building rejects when a row is
missing either side. (Strict enforcement lands in TODO §1d/1e; for this pass
the section is conventional.)
-->

| AC | Test or justification |
|----|-----------------------|
|    |                       |

## Deviations from plan

<!-- Anything we did differently from plan.md, with one-line reasoning. -->

## Known issues

<!-- Bugs / rough edges left for the reviewer. Empty if none. -->

## Commands run

<!-- Notable build/test commands the builder ran. Helps the reviewer reproduce. -->

## Documentation touched

<!--
TODO §1d. List repo-doc updates this run made to the *target* repo (README,
AGENTS.md, CHANGELOG, inline comments, etc.). Validating reads this section
against `git diff` and flags claimed files that aren't actually changed.

Valid formats:

  - README.md — added a /hello endpoint example
  - docs/api.md — documented the new response schema

OR, if no doc updates were warranted:

  none needed — the change is internal-only and has no user-facing surface

Silent skipping is not valid. Either list files or say "none needed — ..."
with a one-line justification.
-->
