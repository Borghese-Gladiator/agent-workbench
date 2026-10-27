# Build report

## What changed

Added `version.txt` at the repo root containing `0.0.1`. One file, one
line — the work itself is trivial; the dogfood goal is exercising the
new live-board card attributes (`+1/-0 across 1 files`, `1/1 ACs
covered`, etc.).

## Files changed

- `version.txt` — new, holds `0.0.1\n`.

## Reviewer reading order

1. `version.txt` — confirm the contents are exactly `0.0.1\n`.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| 1. version.txt exists | `cat version.txt` returns the file |
| 2. version.txt contents == 0.0.1 | `cat version.txt` outputs `0.0.1` |
| 3. No test suite to run | n/a |

## Deviations from plan

None.

## Known issues

None.

## Documentation touched

None.
