# Demo — record Agent Workbench, then show off what it built

One driver, `scripts/demo.mjs`, produces **one continuous `.webm` per run** that
contains BOTH the workbench driving the task AND the built result — all in a
single browser recording, no editing or stitching required.

```
node scripts/demo.mjs --scenario tictactoe   ->  demo-artifacts/tictactoe/tictactoe.webm
node scripts/demo.mjs --scenario core-242    ->  demo-artifacts/core-242/core-242.webm
```

Run it twice (once per scenario) and you have your two video files.

Each recording, in order: the board → the task → the four human gates with the
live agent terminal streaming → then, in the **same** browser session, the built
result (tictactoe: the app opened and a move played; core-242: the draft PR on
GitHub). The agent's own `verification` QA video is also saved alongside (see
Outputs) if you want to splice it in, but it is not required — the single file
already tells the whole story.

## How it works

```
node scripts/demo.mjs --scenario <tictactoe|core-242>
```

`scripts/demo.mjs`:

- boots **one isolated daemon** (real `claude` runtime, throwaway `data/demo-*`),
- boots the **web dev server** with `WORKBENCH_PORT` pointed at that daemon (the
  browser only talks to `/api`, which Vite proxies — so the UI reflects the run
  live),
- creates the project + task,
- spawns a **Playwright-recorded Chromium** (`apps/web/demo-harness/`) that opens
  the live UI and clicks each gate — **Approve Brief → Approve Plan → Complete →
  Approve Delivery** — as the real agent stages complete between clicks,
- reports the UI recording path, the agent's QA `demo-assets/*.webm`, and the PR.

The browser never fires the long gate POSTs blindly: the recorder polls the
daemon for the next gate stage (keeping the streaming terminal on camera), then
clicks the real button — so what's filmed is the product behaving normally.

`--no-record` drives the same gates over the API only (no browser), for a quick
non-video sanity run.

## Scenarios

### `tictactoe` (basic project)
From-scratch build in a fresh local repo (`~/GitHub/wb-tictactoe-demo`). The
agent writes a static tic-tac-toe app, then the `verification` stage plays a
full game to a win in a real browser with video ON. Fast, self-contained.

```
node scripts/demo.mjs --scenario tictactoe
```

Requirements: `claude` CLI logged in.

### `core-242` (enterprise)
Fixes [CORE-242](https://linear.app/klaviyo/issue/CORE-242) — `_CatalogDatasource`
returns a 500 for invalid conversion-value requests — in the **auto-seeded
`[klaviyo] app`** project. The enterprise seed forces `deliveryPolicy: create_pr`
(**draft PR**, never merge), so delivery opens a draft PR against the app repo.

```
node scripts/demo.mjs --scenario core-242
```

Requirements: `claude` CLI logged in, `~/Klaviyo/Repos/app` present (the daemon
seeds `[klaviyo] app` from it on boot), `gh` authed for the draft PR.

## What the single recording contains (in order)

No editing required — the one `.webm` already runs through:

1. **Gated stages** — board → task detail → approve brief (worktree created) →
   discovery/plan → approve plan, with the **live agent terminal** streaming and
   the **permission ladder** (`plan` → `acceptEdits` → `default`) visible.
2. **Verification** — the Demo Evidence panel from the agent's own QA run is
   surfaced before the review gate.
3. **Ship it** — complete review → approve delivery → closeout.
4. **The built result, same session** —
   - `tictactoe`: the built app opened via `file://` and a move played on camera.
   - `core-242`: the **draft PR** opened on GitHub.

If you want a tighter ~60s cut, trim the waits between gates and keep beats 1, 2,
and 4 — but the raw file is already a complete, watchable demo.

## Outputs

- **The deliverable** — one continuous video per run:
  `demo-artifacts/<scenario>/<scenario>.webm` (e.g. `tictactoe/tictactoe.webm`).
  The script prints its path as `VIDEO: ...` at the end.
- Raw Playwright output (same content, nested): `demo-artifacts/<scenario>/test-results/**/video.webm`
- (Optional) the agent's own QA video, if you want to splice it in:
  `data/demo-<scenario>/artifacts/<taskId>/demo-assets/*.webm` — only kept with `--keep`.
- PR URL: printed at the end (and in the task's delivery record).

`demo-artifacts/` and `data/` are gitignored.

## Tuning
- Slower/more legible footage: `--pace 2500` (ms between UI steps).
- Different ports: `--port`, `--web-port`.
- Keep the data dir (worktree + agent QA assets) for inspection: `--keep`.
- Quick no-video sanity run (drives gates over the API only): `--no-record`.
- Files: `scripts/demo.mjs`, `apps/web/demo-harness/playwright.config.ts`,
  `apps/web/demo-harness/record.spec.ts`. No `package.json` entries.
