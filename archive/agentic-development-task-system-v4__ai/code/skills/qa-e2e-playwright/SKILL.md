---
name: qa-e2e-playwright
description: Drive a real end-to-end browser walkthrough with Playwright to prove user-facing functionality, run strictly one at a time. Use for the QA stage when validating that a feature works from the user's perspective, including edge cases.
profile: any
---

# End-to-End Testing with Playwright (shared workbench harness)

You validate the change the way the user trusts it: **full user functionality, end to
end, in a real browser** — not unit or component assertions. The proof is a **browser
video + trace** of the actual feature this task built.

**The workbench owns Playwright and the browser** — you do NOT install or configure
Playwright, and you do NOT scaffold any test infra into the target repo. The target
stays clean. Your only job is to **write one spec** and **run the shared harness**.

## The harness contract (env is already set for you)

The daemon has set these environment variables for this run:

- `QA_TARGET_DIR` — the target app's working dir (where the code under test lives).
- `QA_DEV_COMMAND` — how the app is served; the harness boots this as its webServer
  (it may build-then-run). You do not run it yourself — the harness does.
- `QA_BASE_URL` — the URL the app will be served at (e.g. `http://localhost:5173`).
  Your spec navigates here. If the app's `QA_DEV_COMMAND` serves on a different port,
  say so in your report — the harness waits on `QA_BASE_URL`.
- `QA_SPEC_DIR` — **write your spec file(s) here** (a workbench-side scratch dir).
  This is the ONLY place you write. Never add test files to `QA_TARGET_DIR`.
- `QA_OUTPUT_DIR` — where the harness records video/trace (the daemon captures these
  durably afterward — you do not move them).

## Workflow

1. **Recon the app — by READING, not running.** Read the source under `QA_TARGET_DIR`
   to confirm how a user reaches the feature: the route/page and the accessible
   roles/names you'll target. Do NOT start the app, a dev server, or any process to
   "see it" — the harness boots the app for you in step 3. Starting your own server
   (e.g. `python -m ... ` / `npm run dev`) collides with the harness's own boot on the
   same port and is the #1 cause of wasted turns here.
2. **Write ONE spec** to `"$QA_SPEC_DIR/walkthrough.spec.ts"` (use the Write tool).
   - Navigate to `process.env.QA_BASE_URL` (or `baseURL` is already set — just
     `page.goto('/')`).
   - After each navigation / state-changing click, `await page.waitForLoadState('networkidle')`
     (or await a concrete `getByRole`) before asserting — settle before you inspect.
   - Drive with `getByRole(role, { name })` — assert what the USER sees, not test IDs.
   - Walk the headline feature to completion, plus 1–2 edge cases (reset/empty/draw/error).
   - Keep it serial: `test.describe.configure({ mode: 'serial' })`.
3. **Run the shared harness** (it owns the config, the browser, and boots the app).
   The harness lives in the workbench, not here, so run it via `pnpm -C` so cwd
   doesn't matter:
   ```
   pnpm -C "$QA_HARNESS_CWD" --filter @workbench/web exec playwright test -c qa-harness/playwright.config.ts
   ```
   Run EXACTLY this command — do not invent your own `playwright test` invocation and
   do NOT pass `--project` (the harness config already defines the `chromium` project;
   a bare/other invocation fails with `Project "chromium" not found. Available
   projects: ""`). The harness reads the `QA_*` env, boots the app via `QA_DEV_COMMAND`,
   runs your spec, and records video + trace into `QA_OUTPUT_DIR`.
4. **Read the result**: `QA_OUTPUT_DIR/results.json` (Playwright JSON reporter) tells you
   pass/fail per scenario. Confirm the videos exist under `QA_OUTPUT_DIR/test-results/`.
5. **Prove each scenario is real.** For every scenario, answer the gate **"would this
   have failed BEFORE this change?"** A meaningful scenario asserts behavior the change
   introduced — so on the pre-change code it would have failed. If a scenario would have
   passed before too, it is not proving this task's work: say so and tighten it.
6. **Map criteria → scenarios.** Read the Task Brief's Acceptance Criteria IDs (AC1, AC2,
   …) and the plan's per-criterion validation methods. Map each criterion to the
   scenario(s) that prove it. Any criterion with no proving scenario is a coverage gap —
   report it; it is NOT a pass.

## Hard rules
- **Never start the app or any server yourself** — not to recon, not to "warm it up",
  not in the background. The harness owns the app lifecycle and boots it on
  `QA_BASE_URL`; a server you start collides with it. Recon by reading source only.
- **Do not modify the target app's source.** You write a spec to `QA_SPEC_DIR` only.
- **Do not install Playwright or write a playwright.config** — the harness is the config.
- **Run only the exact harness command above** — no hand-rolled `playwright test`, no
  `--project` flag, no second config.
- **One run at a time** — the harness already enforces `workers: 1`, serial.
- **For any ad-hoc screenshot** (outside this QA harness — e.g. a quick still for a
  report), use the repo's installed Playwright via `node`, NOT the MCP
  `browser_take_screenshot` tool (it does not reliably persist a readable file in
  agent/sandbox environments). Helper:
  `node apps/web/scripts/shot.mjs <url> <out.png> [--full]`.

## Common pitfall
❌ Inspecting the DOM / asserting before the dynamic view settles.
✅ `await page.waitForLoadState('networkidle')` (or await a concrete `getByRole`) first.

## Output
- A pass/fail per scenario with the user-visible assertion that proved it, plus the
  **"would this have failed before this change?"** answer for each.
- A **criterion coverage** map: each Acceptance Criteria ID → the proving scenario(s),
  and any unmapped criterion called out as a gap.
- The produced video(s) + trace paths under `QA_OUTPUT_DIR`.
- Hand the paths to `qa-artifacts` for bundling.
- End with a ```json block:
  `{ "scenarios": [{ "name": "...", "status": "passed"|"failed", "criterionIds": ["AC1"], "wouldFailBefore": true|false }], "criterionCoverage": [{ "criterionId": "AC1", "scenarios": ["..."] }], "uncoveredCriteria": ["..."], "videoPaths": ["..."], "tracePaths": ["..."], "verdict": "PASS"|"FAIL" }`.
