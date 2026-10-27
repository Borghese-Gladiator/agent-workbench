# Human review — 2026-05-22-shogi-core

## Where to start

- Want to see diffs? → `stages/4_building/build.md`
- Want to verify QA? → `stages/5_validating/qa/report.md` (+ `qa/commands.txt`)
- Want to confirm each AC is tested? → `stages/4_building/build.md` § Acceptance criteria coverage
- Want to argue with decisions? → `stages/3_planning/plan.md` § Decisions & assumptions, then `stages/5_validating/review.md`
- Want to see what's next? → `stages/6_followups/follow-ups.md`

**Branch**: `agent/shogi-core`
**Worktree**: `/Users/timothy.shee/GitHub/LOCAL_worktrees/202605_agent_workbench_v2/agentic-development-task-system-v2__ai/agent-workbench-live/worktrees/repo/20260522__shogi-core`
**Repo**: `/tmp/aw-shogi/repo` (new repo created by `start`)

## Suggested first checks

```bash
WT=/Users/timothy.shee/GitHub/LOCAL_worktrees/202605_agent_workbench_v2/agentic-development-task-system-v2__ai/agent-workbench-live/worktrees/repo/20260522__shogi-core
cd "$WT"
git log --oneline -5
python3 -m pytest backend/tests -v
python3 -c "from shogi import Board; print(Board.initial().to_fen())"
```

1. Confirm the pytest line ends with `30 passed`.
2. Confirm the `Board.initial().to_fen()` print is exactly:
   `lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1`
3. Open `backend/shogi/moves.py` and skim `_push_move` + the slider /
   ray section; the promoted-rook / promoted-bishop dragon/horse
   handling is the trickiest piece.
4. Skim `backend/tests/test_moves.py` — read one or two expected sets
   out loud against your shogi intuition.

If steps 1–4 pass, the run is delivered.

## Run timeline

Rendered from `events.jsonl` by `agent-workbench validate`'s audit step.
See `audit.md` (or `stages/5_validating/qa/`) for the full chronological
listing — `new-run` → `shape --init/finalize` → `plan --init/finalize` →
`start` → `validate --init/finalize` → here.
