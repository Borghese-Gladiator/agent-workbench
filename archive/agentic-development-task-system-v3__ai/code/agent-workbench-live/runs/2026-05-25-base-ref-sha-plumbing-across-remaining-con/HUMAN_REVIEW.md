# Human review — 2026-05-25-base-ref-sha-plumbing-across-remaining-con

## Files

- **Brief** — [brief.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__base-ref-sha-plumbing-across-remaining-con/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-base-ref-sha-plumbing-across-remaining-con/stages/2_shaping/brief.md)
- **Plan** — [plan.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__base-ref-sha-plumbing-across-remaining-con/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-base-ref-sha-plumbing-across-remaining-con/stages/3_planning/plan.md)
- **Build (diffs + AC coverage)** — [build.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__base-ref-sha-plumbing-across-remaining-con/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-base-ref-sha-plumbing-across-remaining-con/stages/4_building/build.md)
- **QA report** — [report.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__base-ref-sha-plumbing-across-remaining-con/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-base-ref-sha-plumbing-across-remaining-con/stages/5_validating/qa/report.md)
- **Review decision** — [review.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__base-ref-sha-plumbing-across-remaining-con/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-base-ref-sha-plumbing-across-remaining-con/stages/5_validating/review.md)
- **Audit** — [audit.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__base-ref-sha-plumbing-across-remaining-con/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-base-ref-sha-plumbing-across-remaining-con/audit.md)

## Summary of changes

- 15 file(s) touched:
  - ``lib/validate_context.py` — added local `_effective_ref` helper; added `base_ref_sha` kwarg to `build` and `build_blast_radius`; replaced all five `git diff <base_ref>...HEAD` call sites with the resolved ref. (DR-001)`
  - ``lib/cli/cmd_validate.py` — read `base_ref_sha` from metadata and pass through to `validate_context.build`/`build_blast_radius` (`_write_validate_context_artifacts`), `doc_claims.verify` (`_verify_doc_claims_staged`), and the scope-creep `git diff --name-only` subprocess (`_check_scope_creep_staged`).`
  - ``lib/doc_claims.py` — added `base_ref_sha` kwarg to `verify`; two-line prefer-SHA inline (DR-002).`
  - ``lib/board/source.py` — added `base_ref_sha` kwarg to `_git_shortstat`; updated `load_run_snapshot` to read and pass it through.`
  - ``lib/cli/cmd_start.py` — imported `events`; emit `BaseRefResolved` immediately after the `metadata.update` that writes the resolved SHA (inside the `else` branch where the resolve actually happens — not on the `already_created` path).`
  - ``lib/cli/cmd_new_run.py` — emit `BaseRefResolved` right after the `RunCreated` event when the new-run path resolves a SHA (self-modifying runs only).`
  - ``lib/audit.py` — added `BaseRefResolved` to the notable-events inclusion list and to `_payload_summary`.`
  - ``schemas/events.jsonl` — appended a `BaseRefResolved` event schema definition.`
  - …and 7 more
- 1 doc(s) touched:
  - ``docs/TODO.md` — marked §3 as shipped 2026-05-26 inline with the section heading.`

→ Full diff: `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__base-ref-sha-plumbing-across-remaining-con/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-base-ref-sha-plumbing-across-remaining-con/stages/4_building/build.md`

## Testing

**Unit tests**

`PYTHONPATH=agent-workbench-live python3 -m pytest agent-workbench-live/tests/test_validate_context_build.py -v`

```
- **tests_passed**: true
- **known_issues_count**: 2 (both pre-existing, documented below)
```

✓ tests passed — ⚠ 2 known issue(s); see report.

**Manual testing**

_None recorded._

Review decision: **approve**.

Full QA report:

`/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__base-ref-sha-plumbing-across-remaining-con/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-base-ref-sha-plumbing-across-remaining-con/stages/5_validating/qa/report.md`

## Run timeline

- [23:18:36] SHAPING — entered shaping
- [23:20:21] PLANNING — entered planning
- [23:52:11] PLANNING — assumption ASM-001: `lib/events.py` exposes an append-style API (single function call, takes a payload dict and event type) usable from `cmd_start.py` without further setup.
- [23:52:12] PLANNING — assumption ASM-002: `cmd_validate.py:_verify_doc_claims_staged` is the only call site of `doc_claims.verify` in the workbench. Other code paths (e.g. flat-run validation) either d…
- [23:52:13] PLANNING — assumption ASM-003: The 2026-05-22-token-efficiency-tracking run still has its worktree branch in the source repo's ref database (i.e. `git -C <repo_path> show-ref agent/2026-05-2…
- [23:52:13] PLANNING — assumption ASM-004: No external consumers read `agent-workbench-live/schemas/events.jsonl` or `runs/*/events.jsonl` directly. The schema file is descriptive; adding a new line doe…
- [23:52:14] PLANNING — assumption ASM-005: The new `BaseRefResolved` event's `payload.sha` field name is consistent with how SHAs are named elsewhere in event payloads (e.g. existing `payload.merge_sha`…
- [23:52:14] PLANNING — assumption ASM-006: `bin/pytest` (with `-m unit`) is the correct test runner for these tests and will pick up the new test files automatically.
- [23:52:15] PLANNING — decision DR-001: Add a *local* `_effective_ref` helper inside `lib/validate_context.py` rather than importing `lib/metrics/lines.py:_effective_ref`.
- [23:52:16] PLANNING — decision DR-002: In `lib/doc_claims.py` and `lib/board/source.py:_git_shortstat`, inline the prefer-SHA logic (two lines: `effective_ref = base_ref_sha or base_ref`) rather tha…
- [23:52:16] PLANNING — decision DR-003: Use the `events.append(...)` (or whatever the actual API is — confirmed at build time) function from `lib/events.py` to emit `BaseRefResolved`. Do not write to…
- [23:52:17] PLANNING — decision DR-004: Emit `BaseRefResolved` from `cmd_start.py` only — not from `cmd_new_run.py` (which also resolves the SHA via `repos.resolve_ref_to_sha` at L87).
- [23:52:18] PLANNING — decision DR-005: Add a new test class to `test_board_snapshot.py` that drives `_git_shortstat` directly against a real synthetic git repo, rather than using the existing `seed_…
- [23:52:18] PLANNING — decision DR-006: The backfill computes the fork point as `git -C <target.repo.path> merge-base <target.worktree.branch_name> HEAD`, treating the source repo's current `HEAD` as…
- [23:52:19] PLANNING — decision DR-007: The backfill uses `yaml_io.loads` / `yaml_io.dumps` directly (mirroring `tools/backfill_completion_refs.py`), not `lib/metadata.py:update`.
- [23:52:22] READY — entered ready
- [23:53:55] BUILDING — worktree at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__base-ref-sha-plumbing-across-remaining-con` on `agent/base-ref-sha-plumbing-across-remaining-con`
- [23:53:55] BUILDING — worktree on `agent/base-ref-sha-plumbing-across-remaining-con` at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__base-ref-sha-plumbing-across-remaining-con`
- [00:24:09] VALIDATING — entered validating
- [00:51:45] VALIDATING — doc claims: 1 unverified
- [00:51:46] VALIDATING — review decision: approve
- [00:51:47] VALIDATING — tests_passed=true; known_issues=2
- [00:51:53] FOLLOWUPS — entered followups
- [00:53:41] FOLLOWUPS — 5 follow-up(s) recorded (bug_risk, deferred_from_bounce, refactor, scope_extension, tech_debt)
- [00:54:09] FOLLOWUPS — handoff record created
