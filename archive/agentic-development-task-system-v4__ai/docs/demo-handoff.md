# Demo handoff — Agent Workbench videos

Checkpoint for the next session. Goal: produce **two videos**, one per task —
(1) build Tic-Tac-Toe, (2) fix Linear CORE-242 — each a single continuous `.webm`
showing the workbench driving the task AND the built result.

## Where things live

- **Demo branch:** `demo/workbench-video-driver` (worktree:
  `/Users/timothy.shee/GitHub/agent-workbench-worktrees/demo-video-driver`).
  HEAD `bf68a29`. Based on an OLD main (`c119343`) — does NOT yet contain the
  latest main or the perf fixes. **Must rebase before the real rerun** (see below).
- **Perf-fix branch:** `perf/agent-stage-context-handoff` (worktree:
  `/Users/timothy.shee/GitHub/agent-workbench-worktrees/perf-context-handoff`),
  off latest main (`8e03665`). Carries the investigation TODOs. The actual fixes
  are being implemented in a SEPARATE session.
- **The driver:** `scripts/demo.mjs` + `apps/web/demo-harness/{playwright.config.ts,record.spec.ts}`.
  No `package.json` changes. Output is gitignored under `demo-artifacts/`.

## How to run a demo

```
node scripts/demo.mjs --scenario tictactoe --keep
node scripts/demo.mjs --scenario enterprise --ticket CORE-242 --keep
```

The enterprise scenario is NOT a fixed story — pass any Linear ticket via
`--ticket <id|url>` (e.g. `--ticket CORE-242` or a full linear.app issue URL) and
the agent fetches it from Linear during intake and implements it. Data/artifacts
go to per-ticket dirs (`data/demo-enterprise-<id>/`,
`demo-artifacts/enterprise-<id>/`) so different tickets never clobber each other.

- Boots ONE isolated daemon (real `claude`) on :4602 + the web UI on :5318, both
  wired together; creates the task; spawns a Playwright-recorded Chromium that
  clicks each human gate as the agent stages complete, then shows the built result
  in the same recording.
- `--keep` preserves `data/demo-<scenario>/` (worktree + agent QA video) for
  inspection. Watch live (read-only!) at `http://localhost:5318/tasks/<id>`.
- Deliverable: `demo-artifacts/<scenario>/<scenario>.webm` (printed as `VIDEO:`).
- Flags: `--pace <ms>` (UI beat), `--port`/`--web-port`, `--no-record` (API-only).

Requirements: `claude` CLI logged in. For core-242 also: `~/Klaviyo/Repos/app`
present (daemon auto-seeds `[klaviyo] app`) and `gh` authed (draft PR).

## ✅ Validated so far

- **Video 1 (tictactoe) is DONE and verified.**
  `demo-artifacts/tictactoe/tictactoe.webm` (~43 MB, ~11 min). End-frame visually
  confirmed: the built game on screen, moves played, "Reset game" button. One
  continuous take: gates → real claude build → game played on camera.
  - Built app (kept): `data/demo-tictactoe/worktrees/tic-tac-toe-demo/task_5a2n41ZgdJ-build-a-playable-tic-tac-toe-game/`
    (`index.html` + `game.js` + `README.md`).
  - Agent's own QA video: `data/demo-tictactoe/artifacts/task_5a2n41ZgdJ/demo-assets/*.webm`.
- **The recorder pipeline works end-to-end** (boot → gates → result → single .webm).
- **Enterprise routing works:** core-242 finds the auto-seeded `[klaviyo] app`
  (create_pr / draft PR), does NOT create a project.
- **Transient-ECONNRESET resilience** added and held (`record.spec.ts` taskState
  retries; commit `64deb94`).

## ⏳ What we're waiting for / blockers

1. **Perf fixes must land on main** (other session): thread prior-artifact BODIES
   into stage prompts (the #1 cause of slowness) + per-stage model selection.
   Root cause documented in `docs/TODO.md` (both this branch and the perf branch).
   Without them, runs are slow — core-242's planning stage exceeded the recorder's
   gate timeout (that run failed at `options_plan_test/active`, 19.4 min).
2. **Then: rebase `demo/workbench-video-driver` onto fixed main.** Expected clean
   (perf fixes are in `packages/agents`+daemon; demo files don't overlap). Re-verify
   gate labels (`Approve Brief/Plan`, `Complete`, `Approve Delivery`), the
   `Approval required` heading, and the `demo-assets` path still hold.
3. **Rerun both scenarios.** tictactoe mainly to get a faster/cleaner take;
   core-242 is the real test.

## ⚠️ Known demo-specific issue (NOT fixed by the perf work)

- **Delivery gate doesn't reach `closeout`.** In the tictactoe run that progressed,
  the task ended at `human_delivery_approval/active` — the recorder clicked
  "Approve Delivery" then moved on to show the result, but publish→closeout didn't
  complete (fresh repo, no remote — cosmetic there).
  - For **core-242 the draft PR is the whole payoff**, so this matters. Two things
    to confirm on the next core-242 run: (a) planning/discovery finish in time to
    reach the gates (perf fix handles this), and (b) the delivery gate actually
    opens a draft PR and the recorder lands on it.
  - Likely small recorder tweak: after clicking the final gate, WAIT for
    `closeout` (or for `delivery.prUrl` to be set) before `showResult` navigates to
    the PR. See `apps/web/demo-harness/record.spec.ts` `showResult()` /
    `clearGate('human_delivery_approval', ...)`.

## Suggested next-session order

1. Confirm perf fixes are merged to main.
2. `git -C <demo worktree> rebase main` (or rebase onto the merge commit).
3. Quick re-verify (gate labels/paths) — minutes.
4. Harden delivery→closeout in the recorder (wait for PR/closeout) — fixes the
   known issue above.
5. `node scripts/demo.mjs --scenario tictactoe --keep` (clean fast take).
6. `node scripts/demo.mjs --scenario core-242 --keep` (the real validation — must
   open a draft PR and capture it).
