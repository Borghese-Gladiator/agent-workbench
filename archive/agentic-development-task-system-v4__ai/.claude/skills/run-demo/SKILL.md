---
name: run-demo
description: >-
  Record a video of Agent Workbench driving a real task end-to-end, then showing
  the result. Two scenarios: "tictactoe" (build a playable game from scratch in a
  fresh repo) and "enterprise" (implement ANY Linear ticket you pass via --ticket
  in the seeded [klaviyo] app, ending on a draft PR). Trigger on: "run the demo",
  "/run-demo", "record a demo", "make a demo video", "demo CORE-242", "demo this
  ticket". For the enterprise scenario the user MUST supply a Linear ticket id/url.
version: "1.0"
user-invocable: true
allowed-tools: Bash, Read, Monitor, TaskStop
---

# Run an Agent Workbench demo

Boot an isolated daemon + web UI, create a task, and record a Playwright Chromium
walking it through every human gate — then show the built result — as one
continuous `.webm`. The driver is `scripts/drive.mjs` (record mode) in this repo.

## How to run

Basic (from-scratch app, no ticket):
```
node scripts/drive.mjs --scenario tictactoe --mode record --keep
```

Enterprise (any Linear ticket — REQUIRED, the agent fetches it from Linear):
```
node scripts/drive.mjs --scenario enterprise --ticket CORE-242 --keep
```

Enterprise, persisting the task + artifacts in your REAL daemon (recommended when
you want to keep the run, not just the video). Start your stack first, then attach:
```
pnpm dev   # daemon :4417 + web :5317
node scripts/drive.mjs --scenario enterprise --ticket CORE-242 --attach
```
`--attach` records against the already-running daemon/web instead of spinning up a
throwaway pair — so the task and its artifacts live in your real DB and survive the
run (nothing is spawned or torn down). It fails fast if the stack isn't up. Override
the targets with `--daemon-url`/`--web-url` (default `:4417`/`:5317`).

`record` is the default mode for both scenarios, so `--mode record` is optional.
`--ticket` accepts a bare id (`CORE-242`) or a full `linear.app/.../issue/...` URL.
`--repo app|fender` picks the seeded enterprise repo (default `app`).

Flags: `--attach` (record against your running stack; persists task + artifacts),
`--keep` (preserve `data/record-<scenario>/` for inspection — owned-daemon modes
only), `--pace <ms>` (UI beat), `--port`/`--web-port`, `--no-record` (drive headless
via API, fast validation), `--dry-run` (print the resolved config and exit — no daemon).

## What it needs

- `claude` CLI logged in.
- Enterprise only: `~/Klaviyo/Repos/app` present (daemon auto-seeds `[klaviyo] app`),
  `gh` authed (draft PR), and Linear MCP available to the agent (intake fetches the
  ticket).

## How to drive it (this is long-running — many minutes)

1. Confirm the worktree + branch, and (for enterprise) that the user gave a ticket.
   If the enterprise scenario has no `--ticket`, STOP and ask — the script fails fast
   without it.
2. Launch the command with `run_in_background: true` (a real build is many minutes).
3. Watch progress with a Monitor that filters the log for lifecycle signals:
   `[recorder]|GATE|run start|succeeded|parked|prUrl|VIDEO:|Error|failed|blocked`.
   - "agent run start/succeeded" lines mark stage transitions.
   - Sustained `taskState poll failed` / health timeouts during `validation_demo`
     are usually the synchronous validation step holding the event loop — check for a
     running test process before assuming a hang.
4. The run is done when the log prints `VIDEO: <path>`. Report that path.
5. Print the stage-timing breakdown so the report separates real agent work from
   recorder/gate waiting:
   `node scripts/stage-timing.mjs data/record-<scenario>/workbench.sqlite`
   (scenario dir is `record-tictactoe` or `record-enterprise-<ticket>`). In
   `--attach` mode the run is in your real DB instead: point it at
   `data/workbench.sqlite`. Include the table in the run summary — it explains
   where the wall-clock actually went.

## Output

- Deliverable: `demo-artifacts/<scenario>/<scenario>.webm` (printed as `VIDEO:`).
  Enterprise lands under `demo-artifacts/enterprise-<ticket>/`.
- Watch live (READ-ONLY — do not click the gates, the recorder is): the script logs
  `http://localhost:<web-port>/tasks/<id>`.
- For the enterprise scenario the payoff is a **draft PR** on `klaviyo/app`; verify it
  with `gh pr view <url>` after the run.

## Screenshots (ad-hoc UI capture)

For a quick one-off screenshot (verifying a UI change, grabbing a still), **always
use the repo's installed Playwright via `node` — do NOT use the MCP
`browser_take_screenshot` tool.** The MCP tool reports success but does not reliably
persist a readable file in sandboxed/agent environments; the repo already ships
Chromium + Playwright (under `apps/web`) and a plain `page.screenshot({ path })`
lands a real PNG every time.

Use the helper (dev server must already be running, e.g. `pnpm web`):
```
node apps/web/scripts/shot.mjs http://localhost:5317/usage shot-usage.png --full
```
It prints `SHOT: <abs path>`; `file <path>` should report `PNG image data`. Flags:
`--full` (full page), `--width=N`, `--height=N` (viewport, default 1440x900).

## Notes

- All of `demo-artifacts/` and `data/` are gitignored.
- Each enterprise ticket gets its own data/artifact dir, so runs never clobber.
- See `docs/demo-handoff.md` and `docs/demo-script.md` for the cut/editing guide.
