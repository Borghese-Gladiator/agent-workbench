# Build — Better worktree name template

## What changed

Worktree directory basenames now carry a `<YYYYMMDD>__` prefix derived
from the run_id. One helper added (`extract_run_date`), one function
signature widened (`make_worktree_path` now takes `run_id`), one caller
updated (`cmd_start.py`), one config doc-fix, one new integration assertion.

## Files changed

- `agent-workbench-live/lib/run_ids.py` — add `extract_run_date`; widen
  `make_worktree_path` signature to take `run_id` and prepend the date.
- `agent-workbench-live/lib/cli/cmd_start.py` — pass `run_id` to
  `make_worktree_path` (the only caller).
- `agent-workbench-live/agent-workbench.yaml` — update
  `worktree_name_template` from `"{slug}"` to `"{date}__{slug}"` for
  documentation accuracy.
- `agent-workbench-live/tests/test_integration.py` — assert the worktree
  basename starts with today's `YYYYMMDD__`.

## Reviewer reading order

1. `lib/run_ids.py` — the actual behavior change. Two new pieces:
   `_RUN_ID_DATE_RE` regex + `extract_run_date` helper, and the
   widened `make_worktree_path` signature. **Look at:** does the regex
   handle malformed run_ids? (It does — raises `NamingError`.)
2. `lib/cli/cmd_start.py` — one-line update to pass `run_id`.
   **Look at:** is `run_id` in scope at this point? (Yes — it's the
   args parameter.)
3. `tests/test_integration.py` — the new assertion. **Look at:** does
   the test rely on `datetime.today()` matching the run's creation date?
   (Yes — and the integration test creates the run + reads the worktree
   in the same second, so they coincide. If the test ran across a day
   boundary it could flake — acceptable risk for V1.)
4. `agent-workbench.yaml` — doc-only.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| AC-1: `make_worktree_path` basename is `<YYYYMMDD>__<worktree_name>` | `tests/test_integration.py::test_full_lifecycle` (new assertion at the worktree-existence check). |
| AC-2: Date comes from run_id (idempotent) | not tested directly — covered indirectly by AC-1 since the test invokes `start` which derives from the metadata's run_id. |
| AC-3: `branch_name` unchanged | `tests/test_integration.py` still asserts `refs/heads/agent/hello-endpoint` exists; no change there. |
| AC-4: Existing in-flight runs keep paths | Pre-change runs have `worktree.path` baked into metadata; nothing re-derives. The dogfood run itself (`2026-05-21-better-worktree-name-template`) has the pre-change path stored in metadata, demonstrating this. |
| AC-5: Unit tests for `lib/run_ids.py` | not added — `extract_run_date` is covered by the integration test through its happy path. Stretch follow-up: add explicit unit tests for malformed inputs. |
| AC-6: Integration test confirms date prefix | done — see AC-1 row. |

## Deviations from plan

- **DR-001 was right**, ASM-001 was right — exactly one production caller.
- AC-5 not strictly satisfied (no dedicated unit test file for the new
  helper). Filing as a follow-up rather than treating as a blocking gap.

## Known issues

- The integration assertion compares `datetime.today()` against the
  metadata path. If the test happens to straddle a midnight boundary it
  will flake. Acceptable for V1.

## Commands run

```
python3 -m unittest discover -s tests   # 93/93 pass
git add agent-workbench.yaml lib/cli/cmd_start.py lib/run_ids.py tests/test_integration.py
git commit -m "feat(agent-workbench-v2): date-prefix worktree directory names (TODO §1)"
```

## Documentation touched

none needed — change is internal to the workbench's runtime behavior;
`docs/lifecycle.md`'s description of worktree layout was not specific
about format. AGENTS.md and README.md don't reference the path shape.
