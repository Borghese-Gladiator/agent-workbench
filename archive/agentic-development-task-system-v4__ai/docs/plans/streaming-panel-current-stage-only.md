# Plan: constrain the live streaming panel to the current active stage

## Brief

Today the live `RunTerminal` (the streaming block for the in-flight agent session)
renders **unconditionally** whenever there's an active run, regardless of which stage
the user is viewing in the left rail. Two related annoyances:

1. Clicking back to an older stage still shows the live streaming panel on top.
2. The `autoOpenId` effect **force-jumps** the center view to each newly produced
   artifact as stages advance — so even if the user is reading an older stage, a
   stage change yanks them to the current stage's artifact.

Desired behavior:

- The live streaming panel shows **only when the user is viewing the current
  active stage** (or hasn't explicitly navigated to a past stage — the default).
- When viewing a past stage during a live run, show a **"Jump to current stage"**
  button in place of the panel.
- A stage advance while parked on a past stage must **not** change the active view.
  The agent keeps running; the rail/badges update; the center stays put. The user
  returns to live only by clicking the button (or the current stage).

## Key facts (current code — `apps/web/src/pages/TaskDetail.tsx`)

- `selectedStage` (state, :50) — the stage the user has explicitly selected in the
  rail. `null` = nothing explicitly selected (default / following along).
- `displayRun` (:143) — `{ id, stage, live }`. `live` true = in-flight run streaming.
  Its `stage` is the run's stage, i.e. effectively the current active stage while live.
- Live terminal render (:476–494) — gated only on `displayRun.live`, NOT on which
  stage is selected. **This is the main gate to change.**
- `autoOpenId` effect (:188–214) — auto-opens brief/plan/finished-run artifacts and
  sets `selectedStage` to that artifact's stage. **This is the force-jump.** It fires
  on every `autoOpenId` change, including when a new stage produces an artifact.
- `selectStage` (:268) — sets `selectedStage`; clicking the same stage toggles it off
  (back to `null`).
- `task.stage` (:331) is the canonical current stage; `currentIdx = stageIndex(task.stage)`.

## Design

Introduce one derived notion: **"is the user viewing the current stage?"**

```
// The live run's stage is the current active stage. The user is "on current"
// when they haven't pinned a past stage, OR the stage they pinned IS the live one.
const liveStage = displayRun?.live ? displayRun.stage : null;
const viewingCurrent = selectedStage == null || selectedStage === liveStage;
```

Then:

1. **Gate the live terminal** (:476) on `liveStage && viewingCurrent`. When there's a
   live run but the user is parked on a past stage, render a compact
   **"Live run in progress on {STAGE_LABELS[liveStage]} · Jump to current stage"**
   button instead (calls `selectStage(liveStage)` / or a dedicated `jumpToCurrent`).

2. **Stop the force-jump when parked on a past stage.** The `autoOpenId` effect must
   not move the center/`selectedStage` if the user has explicitly pinned a *different*
   stage. Guard it:
   - Track whether the user is "following" (default) vs "pinned to a past stage".
     Simplest: a `pinnedToPastRef`/derived check — if `selectedStage != null` and
     `selectedStage !== liveStage`, the auto-open effect should be a no-op (early return).
   - This preserves the nice default (a fresh task with `selectedStage == null` still
     auto-opens the latest artifact and follows along).

3. **`jumpToCurrent`** clears the pin: `setSelectedStage(null)` (resume following) — or
   set it explicitly to `liveStage` and let the live terminal + auto-open take over.
   Clearing to `null` is simplest and matches the "follow along" default.

### Edge cases

- No live run (idle / finished / terminal): behavior unchanged — there's no panel to
  gate, and the finished-transcript disclosure (:505) keeps working as today.
- User pinned to the *current* stage explicitly: `viewingCurrent` true → panel shows.
- Run finishes while user is parked on a past stage: `displayRun.live` flips to false,
  `liveStage` becomes null, the "Jump to current" button disappears; the user stays on
  their past stage (no forced jump — the auto-open guard still holds because the finished
  artifact belongs to a different stage than the one they pinned). ✅ matches the ask.
- Auto-advance produces several artifacts while parked: none of them move the view;
  the rail counts/badges still update via the regular `load()` poll. ✅

## Changes

- `apps/web/src/pages/TaskDetail.tsx`
  - Add derived `liveStage` + `viewingCurrent`.
  - Gate the live `RunTerminal` block (:476) on `viewingCurrent`; add an `else` branch
    rendering the "Jump to current stage" button (only when `liveStage && !viewingCurrent`).
  - Add `jumpToCurrent` handler (`setSelectedStage(null)`; clear `centerArtifact` so the
    follow-along auto-open re-populates).
  - Guard the `autoOpenId` effect (:189) to early-return when the user is pinned to a
    past stage (`selectedStage != null && selectedStage !== liveStage`). Add `selectedStage`
    + `liveStage` to its dependency array (or read via a ref to avoid re-running on pin).
  - Keep the finished-transcript disclosure (:505) as-is.
- No new component file needed; the button is a small inline block (matches the existing
  inline `WorktreeCreate`/`RunCenter` pattern). Extract to a tiny `JumpToCurrentBanner`
  only if the JSX grows.

## Tests

### Unit (`apps/web`, vitest + RTL)
Add to (or alongside) the existing `TaskDetail` tests. Use `getByRole(role,{name})`.

1. **Live + following (default):** active run, `selectedStage == null` → the live
   terminal (RunTerminal) renders; no "Jump to current stage" button.
2. **Live + pinned to past stage:** active run on stage N, user clicks an earlier stage
   → live terminal NOT rendered; "Jump to current stage" button IS rendered.
3. **Jump button clears the pin:** from state (2), click "Jump to current stage" → live
   terminal renders again (button gone).
4. **Stage advance does not move a pinned view:** pinned to past stage; simulate a new
   artifact / stage advance via re-render with updated `detail` (new `autoOpenId`) →
   `centerArtifact`/selected stage unchanged (assert the past stage's artifact title is
   still shown, current stage's is not).
5. **No live run:** finished/terminal task → no jump button regardless of `selectedStage`.

Mock `api.getActiveRun` / `api.listRuns` / `api.getArtifact` per existing test setup;
prefer `buildSuccessfulUseQueryResult`-style fixtures if those tests already use them
(otherwise mock the `api` module directly, as the page calls `api.*` imperatively).

### Validation performed (2026-06-17)
- **Unit:** 5 new `TaskDetail.test.tsx` tests — live+following shows the terminal;
  pinned-past hides it + shows "Jump to current stage"; jump restores the terminal;
  pinning the live stage keeps the terminal; a newer auto-openable artifact does NOT
  hijack a manually-pinned past stage. Full web suite **62/62 green**; typecheck clean;
  biome clean on the changed lines.
- **Live (real app via Playwright MCP):** booted an isolated daemon + Vite against a temp
  repo (mock runtime), drove a task to `human_plan_approval`, navigated to the past
  **Discovery** stage → its artifact renders dead-center, the approval gate stays
  reachable, and **no "Jump to current stage" banner** appears (correct: no live run).
  Confirms the rail navigation + the banner's live-run gate in the real UI.
- **LIMITATION (important):** the live *streaming panel itself* cannot be reproduced with
  the **mock** runtime. `produceStageArtifact` only routes through the streaming executor
  when `agentRuntime === 'claude'`; the mock path calls `addMockArtifact` synchronously, so
  the UI never sees an in-flight `activeRun` and the mock-ask hold (`WORKBENCH_MOCK_ASK=1`)
  never fires in the lifecycle driver. Observing the panel + jump-back during an actual
  live stream requires a real `claude` run against a real checkout (a paid CLI run) — the
  same boundary flagged elsewhere in this TODO. The pinned/non-jump LOGIC is fully covered
  by the unit tests; only the live-stream rendering is unverified end-to-end.

### Manual (browser)
1. Start a task; let a live run begin. Confirm the streaming panel shows on the current stage.
2. While it streams, click a **previous** stage in the left rail → streaming panel hides;
   a "Jump to current stage" button appears; the past stage's artifact stays centered.
3. Wait for the agent to **advance a stage** while still parked on the past stage →
   confirm the view does NOT jump; the rail's "current" badge moves; the center is unchanged.
4. Click **"Jump to current stage"** → confirm the live streaming panel returns and follows
   the active stage again.
5. Click the **current** stage explicitly → confirm the panel still shows (viewingCurrent).
6. Let the run finish → confirm the collapsed transcript + auto-opened artifact behavior is
   unchanged for the follow-along case.

## Out of scope
- No daemon/server changes — this is purely a client view-gating concern.
- No change to the finished-run transcript disclosure or cost/turns header.
