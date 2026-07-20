# Implementation plan

## Current repo understanding

Two independent papercuts, both small, both touching the agent-stopping handoff path.

**Papercut 1a — `.lock` not gitignored.** `lib/locks.py` writes `.lock` into the run directory at `<workbench>/runs/<run_id>/.lock`. Now that run dirs live inside the worktree (`agent-workbench-live/runs/<id>/`), the `.lock` file shows up in `git status --porcelain` inside the worktree. `lib/repos.py:245-262 worktree_dirty_files()` returns it; `lib/repos.py:332` (inside `merge_no_ff`) refuses to merge. Root `.gitignore` has no entry for `runs/*/.lock`. The existing `lib/` whitelist pattern (lines 20-22, `!agentic-development-task-system-v{2,3}__ai/agent-workbench-live/lib/`) is the precedent for workbench-scoped gitignore lines.

**Papercut 1b — `ready` banner shell-form.** I expected the bug to be in `_SPECS["ready"]`. It isn't. `_SPECS["ready"]` at `lib/cli/_stop_banner.py:47-53` already has `next_moves=(("start", "approve the plan and create the worktree"),)` — exactly what the brief asks for. The shell-form literal lives in the **renderer**, `_stop_banner.py:101-104`:

```python
elif spec.next_moves:
    lines.append("Next moves (human-triggered):")
    for cmd, desc in spec.next_moves:
        lines.append(f"  agent-workbench {cmd} {run_id}  - {desc}")
```

So the fix is in two places, not one:
1. Change the f-string at line 104 to use `/{cmd}` instead of `agent-workbench {cmd}`.
2. Re-baseline `tests/snapshots/stop_banner_ready.expected.txt`.
3. Update the assertion at `tests/test_stop_banner.py:31` from `self.assertIn("agent-workbench start", out)` to `self.assertIn("/start", out)`, and add the symmetric `assertNotIn("agent-workbench start", out)` (mirroring how `test_human_review_banner_structure` was written at lines 44-47).

The brief's "update `_SPECS["ready"]`" is wrong — but the brief's acceptance criteria (no `agent-workbench start` literal in `_stop_banner.py`, snapshot updated) are reachable through the renderer change. The acceptance criteria win; the brief's pointer is just stale.

**Test surface.** `tests/test_stop_banner.py:24-32` has one positive assertion that pins the shell-form (`assertIn("agent-workbench start", out)`), zero negative assertions today. That asymmetry — positive shell-form pin + zero slash-form check — is what kept the bug invisible. Both papercuts mirror the same shape: the test pins the old behavior, so silently fixing the production code would still pass tests. Test updates land alongside the code.

**Backfill tool.** `tools/backfill_completion_refs.py:1-15` (the module docstring) and lines 32-40 (per-run dict comments) reference the `.lock`-dirty-check gap as a *latent* issue. After this run lands, the docstring should note that the gitignore fix resolves the dirty-check issue and that the script is legacy for pre-fix runs only. No code change to the script itself.

## Relevant files

- `.gitignore` (root) — append the workbench-scoped pattern.
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/_stop_banner.py:101-104` — renderer f-string.
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_stop_banner.py:24-32` — `test_ready_banner_structure` assertion.
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/snapshots/stop_banner_ready.expected.txt` — re-baseline.
- `agentic-development-task-system-v3__ai/agent-workbench-live/tools/backfill_completion_refs.py:1-15` — top-of-file docstring.
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/repos.py:245-262` — `worktree_dirty_files` (verify only, no change).
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/locks.py` — verify the lock file path is `runs/<id>/.lock` (read-only).
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/_stop_banner.py` (banner module docstring) — verify no shell-form examples remain after the f-string fix.
- `docs/TODO.md` — delete §2 (per AGENTS.md two-file contract; happens during this run, before `/complete`).
- `docs/LOG.md` — add dated entry (same contract).

## Proposed changes

### Change 1 — `.gitignore` entry for workbench `.lock` files

Append to root `.gitignore`, in a new `# AGENT WORKBENCH` section near the bottom (after `# AI TOOLS`):

```gitignore
#=====================
#  AGENT WORKBENCH
#=====================
# Per-run lock file written by lib/locks.acquire. Tracked-dir-resident inside
# each run directory; without this entry, every /complete sees it as dirty and
# refuses to merge.
agentic-development-task-system-v3__ai/agent-workbench-live/runs/*/.lock
agentic-development-task-system-v2__ai/agent-workbench-live/runs/*/.lock
```

The v2 line is defensive — v2's `runs/` directory exists but produces no `.lock` files today (v2 is dormant). The symmetric pattern costs nothing and protects against v2 wakeups (see ASM-002).

### Change 2 — renderer slash-form in `_stop_banner.py`

At `lib/cli/_stop_banner.py:101-104`, change the renderer block from:

```python
elif spec.next_moves:
    lines.append("Next moves (human-triggered):")
    for cmd, desc in spec.next_moves:
        lines.append(f"  agent-workbench {cmd} {run_id}  - {desc}")
```

to:

```python
elif spec.next_moves:
    lines.append("Next moves (human-triggered, type in a session):")
    pad = max(len(f"/{cmd} {run_id}") for cmd, _ in spec.next_moves)
    for cmd, desc in spec.next_moves:
        cmd_text = f"/{cmd} {run_id}"
        lines.append(f"  {cmd_text:<{pad}}  — {desc}")
```

Two structural changes to match `_render_next_moves_slash_form()` (the `human_review` renderer at `_stop_banner.py:174-182`):
- Header line gains `", type in a session"` — symmetric with the `human_review` header.
- Padding the slash-form command column to align descriptions, matching the `human_review` rendering.
- Em-dash separator (`—`) replaces ASCII hyphen (`-`), matching the `human_review` rendering character-for-character.

`_SPECS["ready"]` is unchanged. `_HUMAN_REVIEW_NEXT_MOVES` and `_render_next_moves_slash_form` are unchanged.

### Change 3 — `tests/test_stop_banner.py:test_ready_banner_structure`

Replace:

```python
def test_ready_banner_structure(self):
    out = _render("ready")
    self.assertTrue(out.startswith(BORDER + "\n"))
    self.assertTrue(out.rstrip("\n").endswith(BORDER))
    self.assertIn("STOP. State: ready (human-owned).", out)
    self.assertIn(SAMPLE_RUN_ID, out)
    self.assertIn("agent-workbench start", out)
    self.assertIn("Next moves (human-triggered):", out)
```

with:

```python
def test_ready_banner_structure(self):
    out = _render("ready")
    self.assertTrue(out.startswith(BORDER + "\n"))
    self.assertTrue(out.rstrip("\n").endswith(BORDER))
    self.assertIn("STOP. State: ready (human-owned).", out)
    self.assertIn(SAMPLE_RUN_ID, out)
    self.assertIn(f"/start {SAMPLE_RUN_ID}", out)
    # Slash-form replaces the shell-form (TODO §2 acceptance).
    self.assertNotIn("agent-workbench start", out)
    self.assertIn("Next moves (human-triggered, type in a session):", out)
```

Three changes:
- Positive assertion flips from `"agent-workbench start"` to `f"/start {SAMPLE_RUN_ID}"` (matches the new rendered line shape).
- New negative assertion `assertNotIn("agent-workbench start", out)` mirrors lines 45-47 in the human_review test.
- Header literal updated to match the new header line.

### Change 4 — re-baseline `tests/snapshots/stop_banner_ready.expected.txt`

Replace:

```
============================================================
STOP. State: ready (human-owned).
The plan is staged and waiting for human approval.

Next moves (human-triggered):
  agent-workbench start SAMPLE-RUN-ID  - approve the plan and create the worktree
============================================================
```

with:

```
============================================================
STOP. State: ready (human-owned).
The plan is staged and waiting for human approval.

Next moves (human-triggered, type in a session):
  /start SAMPLE-RUN-ID  — approve the plan and create the worktree
============================================================
```

Padding is computed off `/start SAMPLE-RUN-ID` (length 21). Because `ready` has exactly one slash entry, the rendered text aligns trivially.

### Change 5 — `tools/backfill_completion_refs.py` docstring

Add one paragraph to the module docstring (after the `Idempotent` line, before `Usage:`):

```
The dirty-tree refusal that forced manual merges for these runs was the
runs/<id>/.lock file showing up in git status --porcelain. That root cause
was fixed by adding a workbench-scoped .gitignore entry (see docs/LOG.md
under "Lifecycle papercuts"); from that point on, /complete merges without
--no-merge and no new entries should be added to BACKFILL below.
```

No code change. The per-run dict comments (lines 32-40) stay — they're historical record.

### Change 6 — two-file contract

When the code lands and tests pass, **before `/complete`**:

- Delete `docs/TODO.md` §2 ("Lifecycle papercuts"). Renumber §§3-9 → §§2-8.
- Add a `## 2026-05-25` entry to `docs/LOG.md` (or append to today's if one exists): the two papercuts, the commit SHAs, the test-count delta (one snapshot file rebaselined, one test method modified, +0 net cases). One paragraph each papercut, plus a one-paragraph reflection on the brief's mis-pointer (the `_SPECS` fix that turned out to be a renderer fix).

## Files likely to change

- `.gitignore` (root)
- `agentic-development-task-system-v3__ai/agent-workbench-live/lib/cli/_stop_banner.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/test_stop_banner.py`
- `agentic-development-task-system-v3__ai/agent-workbench-live/tests/snapshots/stop_banner_ready.expected.txt`
- `agentic-development-task-system-v3__ai/agent-workbench-live/tools/backfill_completion_refs.py`
- `agentic-development-task-system-v3__ai/docs/TODO.md`
- `agentic-development-task-system-v3__ai/docs/LOG.md`

Seven files total. No code under `lib/` other than `_stop_banner.py`.

## Data model changes

None.

## UI changes

The `ready` stop banner's text output. No code outside `_stop_banner.py` consumes the text as a parsed contract (verified by grep against the worktree); the only consumer is the snapshot test plus a freeform human reader.

## Test plan

- **Existing**: `tests/test_stop_banner.py::test_ready_banner_structure` — updated assertions (see Change 3). Must pass on the new rendering, fail on the old.
- **Existing**: `tests/test_stop_banner.py::test_human_review_banner_structure` (lines 34-48) — must still pass unchanged. The renderer change applies to the `elif spec.next_moves:` branch, which `human_review` does not take (its `next_moves` tuple is empty; it uses `_build_human_review_body`). No collateral damage expected.
- **Existing**: Other states (`done`, `abandoned`) — same logic, take the `else: terminal_line` branch. No expected change. Run the full suite to confirm.
- **New**: One unit test method, `test_ready_banner_no_shell_form`, asserts `"agent-workbench"` does not appear in any rendered banner output across the four agent-stopping states. Pinned at the module level so a future banner spec regression on any state catches itself.

```python
def test_no_shell_form_in_any_banner(self):
    """Pin slash-form across every state (TODO §2 hardening)."""
    for state in ("ready", "human_review", "done", "abandoned"):
        out = _render(state)
        self.assertNotIn(
            "agent-workbench ",
            out,
            f"shell-form leaked into {state} banner",
        )
```

(Renamed to `test_no_shell_form_in_any_banner` for clarity. Naming TBD during build.)

- **Snapshot**: re-baselined per Change 4. The snapshot test consuming this file lives in `tests/test_stop_banner.py` — I'll confirm during build (likely a sibling method using a `_read_snapshot()` helper, or wrapped into one of the existing tests via `assertEqual(out.strip(), expected.strip())`).
- **Gitignore unit test**: introduce one new test method in a new file or extend existing infrastructure. Shape:

```python
def test_lock_file_not_dirty_in_run_dir(self):
    """The workbench-scoped .gitignore line excludes runs/<id>/.lock."""
    # In a tmp workbench, init git, create runs/<id>/.lock, run
    # `git status --porcelain`, assert empty.
```

This is the headline acceptance from the brief ("`/complete` succeeds without --no-merge"). The unit test pins the gitignore line directly; an E2E `/complete` test would be redundant cost — the brief explicitly accepts unit-level coverage as long as the gitignore line is asserted.

## QA plan

1. Run the full workbench test suite. Expect: all green; one snapshot re-baselined; one test method modified; +1 new method (the no-shell-form pin); +1 new method (the gitignore pin). Net case delta: +2.
2. Manual smoke: in the worktree, `touch agent-workbench-live/runs/2026-05-25-lifecycle-papercuts-lock-ready-banner/.lock`, then `git status --porcelain` — should be empty.
3. Manual smoke: render the `ready` banner via a one-liner (`python -c "from lib.cli._stop_banner import print_stop_banner; print_stop_banner('ready', 'SAMPLE')"`). Inspect output. Confirm slash-form, em-dash, header.
4. Grep the workbench for any remaining `agent-workbench start` literal in production code (excludes runs/, docs/, README.md). Should match only `tests/snapshots/...` and runs/ historical artifacts.
5. After the code commits land, drive the run through `/validate` → `/followups` → `/complete`. The `/complete` should succeed without `--no-merge`. This is the live dogfood evidence for acceptance criterion 1.

## Risks

- **Risk: a hidden consumer parses the `ready` banner text.** Mitigated by grep against the worktree showing only `tests/` references. Low.
- **Risk: the em-dash character breaks a downstream encoding.** All banner output goes to stdout; the existing `human_review` banner already uses em-dash and ships. Low.
- **Risk: the gitignore entry pattern is wrong relative to monorepo gitignore evaluation order.** Mitigated by the existing precedent at lines 20-22 of `.gitignore` (the `lib/` whitelist) using identical path-prefix patterns. Low.
- **Risk: v2 gitignore line drifts later if v2 wakes up.** Defensively included; if v2 becomes active and `.lock` semantics change, that's a separate run's problem. Acceptable.
- **Risk: the headline acceptance (`/complete` without `--no-merge`) only fires when this very run is completed.** The fix can't be QA'd ahead of `/complete` itself. Mitigated by the unit-level test on `worktree_dirty_files` semantics + the manual smoke in QA step 2.

## Definition of done

- Both papercut fixes landed in the worktree (Changes 1-5 above).
- `tests/test_stop_banner.py` passes with the two assertion updates and one new method.
- The new gitignore unit test passes (location TBD during build — likely `tests/test_gitignore_lock.py` or extended into an existing test file).
- Snapshot `tests/snapshots/stop_banner_ready.expected.txt` re-baselined to the slash-form text.
- `tools/backfill_completion_refs.py` module docstring updated.
- `docs/TODO.md` §2 deleted, sections renumbered.
- `docs/LOG.md` has a dated entry covering both papercuts and the brief's mis-pointer.
- `/complete` of this run produces a clean `git merge --no-ff` without `--no-merge` (this is acceptance criterion 1).

## Preflight

- Workbench tests run from `agent-workbench-live/` (no special config); `pytest` resolves the suite via the directory's existing harness. Confirmed by inspecting `runs/2026-05-25-each-worktree-owns-its-own-run-dir/`'s shipped state — same suite, same invocation pattern.
- Worktree is at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__lifecycle-papercuts-lock-ready-banner`. Already created by `new-run` per the post-A1 contract. `git branch --show-current` inside the worktree returns `agent/lifecycle-papercuts-lock-ready-banner` (confirmed via metadata).
- `base_ref_sha` is `e657d140dca7172d25300c9165e16f6fa4156bc8`. Diffs against this ref produce the worktree's commits.
- No new packages, no new dependencies. No build artifacts.
- v2 sibling `agentic-development-task-system-v2__ai/agent-workbench-live/runs/` exists but contains no `.lock` files (confirmed via find).

## Decisions & assumptions

### DR-001
- **Decision**: Fix the renderer (`_stop_banner.py:101-104` f-string), not `_SPECS["ready"]`.
- **Rationale**: `_SPECS["ready"]` already has the right `("start", ...)` entry. The `agent-workbench` literal is constructed at render time. Mutating the spec would require rendering callers to interpret two formats; mutating the renderer is one place and one change.
- **Alternatives considered**: (a) Add a `prefix: str` field to `_BannerSpec` defaulting to `"agent-workbench "` and override to `"/"`. (b) Add a per-state branch in the renderer (`if landing_state == "ready": …`). (c) Move `ready` to its own body-builder helper symmetric to `_build_human_review_body`.
- **Why not the alternatives**: (a) introduces a configurable knob for a one-axis choice the workbench has already made — slash-form for everything. (b) couples renderer to state names, the exact anti-pattern `_SPECS` was created to avoid. (c) overkill for a single command + description line; the brief's non-goal explicitly rules out a five-section body for `ready`.

### DR-002
- **Decision**: Mirror `_render_next_moves_slash_form`'s padding + em-dash + header line ("type in a session") rather than minimally swapping `agent-workbench` for `/`.
- **Rationale**: Symmetry with the `human_review` banner is the brief's user-facing goal (the inconsistency between the two banners is exactly what triggered the TODO entry). Cosmetic alignment matters because the user *sees these banners back-to-back*. Half-symmetry (slash-form prefix but ASCII hyphen + no padding) would still look like two different banners.
- **Alternatives considered**: Minimal swap — only replace `agent-workbench` with `/`, leave header + separator + padding untouched.
- **Why not the alternatives**: Future-you reading two banners back-to-back would still see them as different. The cost of full symmetry is three extra lines of code in the renderer.

### DR-003
- **Decision**: Add a defensive v2 gitignore line even though v2 is dormant.
- **Rationale**: One line, zero cost. Protects against a v2 wakeup that mirrors v3's lock semantics. The narrow path-prefix pattern can't bite anything else.
- **Alternatives considered**: v3-only line; postpone v2 to a follow-up.
- **Why not the alternatives**: A follow-up for one extra gitignore line is bookkeeping debt. The risk of leaving v2 unprotected is low but non-zero; the cost of including it is one line of text.

### DR-004
- **Decision**: Cover the gitignore fix with a unit test pinning `worktree_dirty_files` semantics, not an E2E `/complete` test.
- **Rationale**: The brief's headline acceptance is "`/complete` succeeds without `--no-merge`". The headline can only be verified live (during this run's own `/complete`). A unit test pinning `worktree_dirty_files` returns empty for a tmp workbench with a `.lock` covers the gitignore contract directly, runs cheaply, doesn't need a full git worktree fixture, and fails loudly if the pattern is silently broken in the future.
- **Alternatives considered**: A full E2E test that spawns a tmp workbench, drives `new-run → start → … → complete`, asserts no `--no-merge` is needed.
- **Why not the alternatives**: TODO §5 already calls out test-coverage gaps for E2E `/complete` paths (it lists no-banner-on-abort runtime, snapshot test for human_review, etc.). Adding one more E2E test specifically for this papercut would belong inside that effort, not this one. The unit test covers the gitignore line directly; the live `/complete` of this run is the E2E evidence.

### DR-005
- **Decision**: Update one existing test method (`test_ready_banner_structure`) AND add one new pinning method (`test_no_shell_form_in_any_banner`), rather than just updating the existing one.
- **Rationale**: The existing method updated alone would prevent regressions of `ready` but not of *another* state. The cross-state pin catches any future banner that re-introduces shell-form, regardless of which state it lands in. Cheap defense in depth.
- **Alternatives considered**: Only update the existing test method. Or add the cross-state pin as a parametrize on the existing methods.
- **Why not the alternatives**: Update-only leaves a regression surface. Parametrize is fine but the test file uses class-method idiom throughout; introducing parametrize for one assertion is style drift.

### ASM-001
- **Text**: No code outside `tests/` and `runs/` (historical) reads the `ready` banner text as a parsed contract.
- **Reason**: Grep against the worktree for `agent-workbench start` shows only test files, `runs/` artifacts (historical, ok), `README.md` (shell example, separate context), and `.claude/commands/start.md` (slash-command doc text, separate context).
- **Impact**: low

### ASM-002
- **Text**: v2 is dormant — no new `.lock` files will be written under `agentic-development-task-system-v2__ai/agent-workbench-live/runs/<id>/.lock` during this run or in the near future.
- **Reason**: `find agentic-development-task-system-v2__ai/.../runs -name .lock` returns nothing. v2's `runs/` dir contains only `archived/` history.
- **Impact**: low. The v2 gitignore line is defensive only.

### ASM-003
- **Text**: The snapshot consumer in `tests/test_stop_banner.py` loads the snapshot file verbatim and compares against `_render("ready")` output, with no normalization that would mask whitespace/em-dash differences.
- **Reason**: The snapshot file is a small `.expected.txt`; the existing `human_review` snapshots (under the same `snapshots/` dir, per `tests/test_human_review.py`) use a `_normalize(...)` helper to collapse `<TMP>`/`<TEST_REPO>`/timestamps. For `ready`, none of those tokens appear; verbatim comparison is fine. Will confirm during build by reading the consumer test method.
- **Impact**: medium. If the consumer normalizes em-dashes (unlikely but checkable), the new snapshot needs the ASCII hyphen instead. Build-time check resolves it.

### ASM-004
- **Text**: The `/complete` of this run will, when it runs, exercise the new gitignore line — confirming the fix on the live evidence path the brief specifies.
- **Reason**: The lock-file workflow is identical: `locks.acquire` writes `.lock` into `runs/<id>/.lock`; `merge_no_ff` calls `worktree_dirty_files`; the new gitignore line excludes that path; the dirty list is empty; the merge proceeds.
- **Impact**: high. This is the headline acceptance evidence. If anything trips it up live (e.g. the workbench root resolver caching, or the run dir living at a slightly different path than I'm assuming), that's the place I'll catch it.

### ASM-005
- **Text**: `_stop_banner.py`'s module docstring (line 1-17) describes the renderer's behavior and won't need an update for the slash-form change — it speaks at the level of "agent-stopping states" and the body shape, not the specific command literal.
- **Reason**: Re-read the docstring; it talks about `landing_state`, the `human_review` five-section body, and the `cfg` fallback. No `agent-workbench` literal in the docstring text.
- **Impact**: low.
