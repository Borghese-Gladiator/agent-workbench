# Implementation plan

## Current repo understanding

Throwaway one-file repo at `/tmp/aw-dogfood-section2`. Single README.
No build system, no tests, no CI. Just a target for `new-run`.

## Relevant files

- `version.txt` (new) — at repo root.

## Proposed changes

Write `0.0.1\n` to `version.txt`. That is the entire diff.

## Files likely to change

- `version.txt`

## Data model changes

None.

## UI changes

None.

## Test plan

No unit tests. QA records a manual `cat version.txt` check.

## QA plan

```
cat version.txt
```

Expect: `0.0.1`. QA reviewer confirms manually, then records
`QACompleted` with `tests_passed: true`, `known_issues_count: 0`.

## Risks

None worth listing.

## Definition of done

`version.txt` exists with the expected content; review.md + qa/report.md
+ audit.md exist; one follow-up entry recorded.

## Preflight

- Repo exists, has a clean working tree.
- `git` available.
- Worktree path will be allocated by `agent-workbench start`.

## Decisions & assumptions

### DR-001
- **Decision**: Use `0.0.1` as the version string (semver-style).
- **Rationale**: Standard convention; unambiguous.
- **Alternatives considered**: `v0.0.1`, `0.1`, raw timestamp.
- **Why not the alternatives**: Less standard; not the point.

### ASM-001
- **Text**: The repo is fine to mutate freely — it's a `/tmp` throwaway.
- **Reason**: We created it ten minutes ago.
- **Impact**: low.
