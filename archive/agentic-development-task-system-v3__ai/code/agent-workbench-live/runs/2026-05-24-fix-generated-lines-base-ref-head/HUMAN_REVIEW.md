# Human review — 2026-05-24-fix-generated-lines-base-ref-head

## Files

- **Brief** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-fix-generated-lines-base-ref-head/stages/2_shaping/brief.md`
- **Plan** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-fix-generated-lines-base-ref-head/stages/3_planning/plan.md`
- **Build (diffs + AC coverage)** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-fix-generated-lines-base-ref-head/stages/4_building/build.md`
- **QA report** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-fix-generated-lines-base-ref-head/stages/5_validating/qa/report.md`
- **Review decision** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-fix-generated-lines-base-ref-head/stages/5_validating/review.md`
- **Audit** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-fix-generated-lines-base-ref-head/audit.md`

## Summary of changes

- 7 file(s) touched:
  - ``agent-workbench-live/lib/repos.py` — new `resolve_ref_to_sha(repo_path, ref)` helper that wraps `git rev-parse --verify`, raises `RepoError` on failure.`
  - ``agent-workbench-live/lib/cli/cmd_start.py` — resolves `base_ref` to a SHA against the source repo *before* `git worktree add`; persists via the existing `_m(d)` mutator alongside `worktree.path` / `worktree.created`. Failure surfaces as a clean `fail(..., 2)`.`
  - ``agent-workbench-live/lib/metrics/lines.py` — both `count_generated` and `count_accepted` gain an optional `base_ref_sha` kwarg. New `_effective_ref(worktree_path, base_ref, base_ref_sha)` returns the SHA if present; else lazy `git rev-parse --verify <base_ref>` inside the worktree; else the symbolic ref (today's behavior — strict-improvement fallback).`
  - ``agent-workbench-live/lib/metrics/writer.py` — reads `repo.base_ref_sha` next to `repo.base_ref` and passes both through to `count_generated` and `count_accepted`.`
  - ``agent-workbench-live/schemas/run-metadata.yaml` — adds optional `target.repo.base_ref_sha` field (string or null) with description; adds `base_ref_sha: null` to the illustrative `template:` block.`
  - ``agent-workbench-live/tests/test_metrics_lines.py` — new `TestBaseRefShaResolution` class: 4 tests covering symbolic-`HEAD`-with-captured-SHA, lazy-resolver branch case, bad-ref fallback (no crash), and the `count_accepted` parallel.`
  - ``agent-workbench-live/tests/test_repos.py` — new `TestResolveRefToSha` class: 3 tests (HEAD → full SHA, branch name → full SHA, missing ref raises).`

→ Full diff: `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-fix-generated-lines-base-ref-head/stages/4_building/build.md`

## Testing

**Unit tests**

`python -m pytest tests/ -q`

```
- **tests_passed**: true (240 passed; 2 pre-existing date-baked snapshot failures on master, unrelated to this change)
- **known_issues_count**: 0
```

✓ all green — 0 known issues.

**Manual testing**

_None recorded._

Review decision: **approve**.

Full QA report:

`/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-fix-generated-lines-base-ref-head/stages/5_validating/qa/report.md`

## Run timeline

- [21:18:10] SHAPING — entered shaping
- [21:19:21] PLANNING — entered planning
- [21:23:04] PLANNING — assumption ASM-001: `git rev-parse --verify HEAD` against the source repo at `/start` returns the same 40-char SHA that `git worktree add ... HEAD` will fork from.
- [21:23:04] PLANNING — assumption ASM-002: Existing `metadata.yaml` files under `runs/*/` will continue to load via `metadata.load()` without modification when we add an optional `base_ref_sha` field to…
- [21:23:04] PLANNING — assumption ASM-003: Existing E2E snapshot tests do not pin the literal contents of `metadata.yaml` such that adding a new optional field breaks them.
- [21:23:04] PLANNING — assumption ASM-004: The dogfood run's worktree at `~/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/...` may or may not still exist on disk; QA-3 is best-…
- [21:23:04] PLANNING — assumption ASM-005: There is no `agent-workbench doctor` command that hard-validates every field in the YAML schema against `schemas/run-metadata.yaml`. (To verify in QA-4.)
- [21:23:04] PLANNING — decision DR-001: Add `target.repo.base_ref_sha` (Option (a) from the brief) rather than rewriting `target.repo.base_ref` in place.
- [21:23:04] PLANNING — decision DR-002: Capture the SHA against the **source repo** at `/start` time, *before* the worktree exists. The lazy fallback in `lines.py` runs against the **worktree** at me…
- [21:23:04] PLANNING — decision DR-003: Make `base_ref_sha` an optional metadata field; gate the lazy resolver on "field absent." Don't error out if it's absent — fall back transparently.
- [21:23:04] PLANNING — decision DR-004: Both `count_generated` and `count_accepted` get the new `base_ref_sha` parameter, even though the brief only calls out `count_generated` explicitly.
- [21:23:04] PLANNING — decision DR-005: The lazy fallback uses `git rev-parse` inside the **worktree**, not the source repo. If that fails or returns empty, fall back to the *symbolic* `base_ref` (to…
- [21:23:04] READY — entered ready
- [21:23:16] BUILDING — worktree at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260524__fix-generated-lines-base-ref-head` on `agent/fix-generated-lines-base-ref-head`
- [21:23:16] BUILDING — worktree on `agent/fix-generated-lines-base-ref-head` at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260524__fix-generated-lines-base-ref-head`
- [21:33:02] VALIDATING — entered validating
- [21:36:51] VALIDATING — doc claims: all verified
- [21:36:51] VALIDATING — review decision: approve
- [21:36:51] VALIDATING — tests_passed=true; known_issues=0
- [21:36:51] FOLLOWUPS — entered followups
- [21:38:37] FOLLOWUPS — 4 follow-up(s) recorded (refactor, scope_extension, tech_debt)
- [21:38:37] FOLLOWUPS — handoff record created
