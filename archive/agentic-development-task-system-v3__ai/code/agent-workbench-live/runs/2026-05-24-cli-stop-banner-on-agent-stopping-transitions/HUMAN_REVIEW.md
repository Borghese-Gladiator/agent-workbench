# Human review — 2026-05-24-cli-stop-banner-on-agent-stopping-transitions

## Files

- **Brief** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-cli-stop-banner-on-agent-stopping-transitions/stages/2_shaping/brief.md`
- **Plan** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-cli-stop-banner-on-agent-stopping-transitions/stages/3_planning/plan.md`
- **Build (diffs + AC coverage)** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-cli-stop-banner-on-agent-stopping-transitions/stages/4_building/build.md`
- **QA report** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-cli-stop-banner-on-agent-stopping-transitions/stages/5_validating/qa/report.md`
- **Review decision** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-cli-stop-banner-on-agent-stopping-transitions/stages/5_validating/review.md`
- **Audit** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-cli-stop-banner-on-agent-stopping-transitions/audit.md`

## Summary of changes

- 14 file(s) touched:
  - ``agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/_stop_banner.py` — NEW. Single public function `print_stop_banner(landing_state, run_id)`. Internal `_BannerSpec` table maps each of the four landing states to a (header, explanation, next-moves, terminal-line) tuple. Invalid state → `ValueError`. 60-column ASCII border.`
  - ``agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_plan.py` — import + `print_stop_banner("ready", run_id)` after the `planning -> ready` success print (default branch only; not on `--init`).`
  - ``agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_validate.py` — import + `print_stop_banner("human_review", run_id)` at the very end of the flat-layout `validating -> human_review` success path. NOT wired into the staged `validating -> followups` branch (the agent still drives followups).`
  - ``agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_followups.py` — import + `print_stop_banner("human_review", run_id)` after the `followups -> human_review` success print (default branch only).`
  - ``agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_complete.py` — import + `print_stop_banner("done", run_id)` after the `human_review -> done` success print. Failure paths (dirty worktree, merge conflict, missing audit.md) all `return fail(...)` earlier so the banner cannot fire on abort.`
  - ``agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/cmd_abandon.py` — import + `print_stop_banner("abandoned", run_id)` after the `-> abandoned` success print.`
  - ``agentic-development-task-system-v3__ai/agent-workbench-live/AGENTS.md` — one-sentence paragraph added under "How to drive the workbench" telling the agent what to do when it sees the banner.`
  - ``agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_stop_banner.py` — NEW. 11 tests: 4 structural per-state tests, 1 invalid-state ValueError test, 1 batch test of six other lifecycle states that should raise, 1 border-width pin, 4 snapshot tests (env-guarded re-baseline via `WRITE_SNAPSHOTS=1`).`
  - …and 6 more
- 1 doc(s) touched:
  - ``agentic-development-task-system-v3__ai/agent-workbench-live/AGENTS.md` — added one paragraph under "How to drive the workbench" explaining how the agent should treat the `STOP.` banner.`

→ Full diff: `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-cli-stop-banner-on-agent-stopping-transitions/stages/4_building/build.md`

## Testing

**Unit tests**

`python3 -m pytest tests/test_stop_banner.py -v`

```
- **tests_passed**: true
- **known_issues_count**: 0

The full `agent-workbench-live/tests/` suite was run twice — once in the worktree (with the banner work applied), and once against the master checkout to confirm pre-existing failures. Both runs produced the same set of 2 failures (date-baked snapshot drift in `test_human_review.py`); 244 tests pass in the worktree, all 11 new unit/snapshot tests are green, and the extended E2E assertions for STOP banner presence/absence all pass.
```

✓ all green — 0 known issues.

**Manual testing**

_None recorded._

Review decision: **approve**.

Full QA report:

`/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-cli-stop-banner-on-agent-stopping-transitions/stages/5_validating/qa/report.md`

## Run timeline

- [21:17:21] SHAPING — entered shaping
- [21:18:45] PLANNING — entered planning
- [21:22:42] PLANNING — assumption ASM-001: All five `cmd_*.py` success paths are reachable in isolation; placing the banner call between the last `print` and `return 0` does not change exit codes or sid…
- [21:22:42] PLANNING — assumption ASM-002: The E2E test harness's `subprocess.run(..., capture_output=True)` captures all stdout produced by the CLI subprocess, including the new banner lines.
- [21:22:42] PLANNING — assumption ASM-003: The `lib.cli._stop_banner` module can be imported from each `cmd_*.py` without circular imports because the helper has no dependencies on other `cmd_*.py` modu…
- [21:22:42] PLANNING — assumption ASM-004: `validate --init` (line 273 in `cmd_validate.py`) lands the run at `validating`, not `human_review` or `followups`. Adding the banner to the default mode only …
- [21:22:42] PLANNING — assumption ASM-005: `cmd_plan.py`'s `--init` path (line 154) lands the run at `shaping` (still in shaping). Wait — actually re-reading: `--init` requires status=planning and stage…
- [21:22:42] PLANNING — assumption ASM-006: The two pre-existing date-baked snapshot drift failures on master (mentioned in the most recent LOG entries) will not be re-baselined by this run; the test pla…
- [21:22:42] PLANNING — assumption ASM-007: The order of stdout lines in `cmd_validate.py`'s flat-layout path (`validating -> human_review`, `branch:`, `worktree:`, `audit:`) does not need to change; the…
- [21:22:42] PLANNING — assumption ASM-008: A merge-conflict failure path in `cmd_complete.py` already exits via `return fail(str(e), e.exit_code)` (line 119) BEFORE reaching the success print at line 13…
- [21:22:42] PLANNING — decision DR-001: One shared helper module `lib/cli/_stop_banner.py` owns the banner format. Every call site passes only `landing_state` and `run_id`.
- [21:22:42] PLANNING — decision DR-002: Banner is plain ASCII, fixed at 60 columns, plain `print()` to stdout. No ANSI escapes, no Unicode.
- [21:22:42] PLANNING — decision DR-003: Banner prints only on the actual success path of each command, after the transition is durably recorded.
- [21:22:42] PLANNING — decision DR-004: Terminal states (`done`, `abandoned`) omit the "Next moves" block and substitute a "Terminal state." line instead.
- [21:22:42] PLANNING — decision DR-005: Invalid `landing_state` raises `ValueError`. Call sites are internal — defensive validation, not user-facing.
- [21:22:42] PLANNING — decision DR-006: Wire the banner into `cmd_validate.py` only on the flat-layout `validating -> human_review` path (line 444). The staged path that lands at `followups` (line 39…
- [21:22:42] PLANNING — decision DR-007: One unit-test module `tests/test_stop_banner.py` covers both the helper's behavior and the four snapshot fixtures. The E2E test extension lives in `tests/test_…
- [21:22:42] PLANNING — decision DR-008: AGENTS.md cross-reference is one paragraph inserted at the start of "How to drive the workbench" (between the heading and the existing `Run the CLI:` paragraph…
- [21:22:42] READY — entered ready
- [21:22:53] BUILDING — worktree at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260524__cli-stop-banner-on-agent-stopping-transitions` on `agent/cli-stop-banner-on-agent-stopping-transitions`
- [21:22:53] BUILDING — worktree on `agent/cli-stop-banner-on-agent-stopping-transitions` at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260524__cli-stop-banner-on-agent-stopping-transitions`
- [21:34:00] VALIDATING — entered validating
- [21:36:02] VALIDATING — doc claims: 1 unverified
- [21:36:02] VALIDATING — review decision: approve
- [21:36:02] VALIDATING — tests_passed=true; known_issues=0
- [21:36:02] FOLLOWUPS — entered followups
- [21:36:47] FOLLOWUPS — 3 follow-up(s) recorded (docs, tech_debt)
- [21:36:47] FOLLOWUPS — handoff record created
