import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * DEMO recorder: opens the live workbench UI on the task `scripts/drive.mjs`
 * created, then walks it through the four human gates AS A HUMAN WOULD — reading
 * the panel, watching the agent terminal stream, clicking approve — while
 * Playwright records the browser. The footage is the raw material for the 3-act
 * cut in docs/demo-script.md.
 *
 * Everything that takes time (the real claude implementation + QA-video stages)
 * happens BETWEEN gate clicks; the recorder simply waits for the next gate to
 * appear, keeping the streaming terminal on camera. It does not fire the gate
 * POSTs itself — it clicks the real buttons — so what's recorded is the product.
 */

const API_BASE = need('DEMO_API_BASE'); // http://127.0.0.1:<port>/api
const TASK_ID = need('DEMO_TASK_ID');
const PACE = Number(process.env.DEMO_PACE_MS ?? 1500);

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`demo recorder: missing env ${name}`);
  return v;
}

const beat = (page: Page, ms = PACE) => page.waitForTimeout(ms);

/**
 * Current stage + status from the daemon — ground truth for "did we advance".
 *
 * A single poll MUST NOT kill a 20-minute recording: the daemon momentarily
 * drops sockets (ECONNRESET) while it spawns the verification QA subprocess
 * under load. So retry transient failures a few times and, if they persist,
 * return `unknown` (the poll loop simply tries again next tick) rather than
 * throwing. Mirrors the driver's tolerant fire-and-poll (scripts/lib/driver-core.mjs).
 */
async function taskState(page: Page): Promise<{ stage: string; status: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await page.request.get(`${API_BASE}/tasks/${TASK_ID}`, { timeout: 15_000 });
      const body = await res.json();
      return { stage: body?.task?.stage ?? 'unknown', status: body?.task?.status ?? 'unknown' };
    } catch (err) {
      // Transient — back off briefly and retry; never let one poll end the run.
      await page.waitForTimeout(2000);
      if (attempt === 4) {
        console.warn(`[recorder] taskState poll failed (${(err as Error).message}); will retry`);
      }
    }
  }
  return { stage: 'unknown', status: 'unknown' };
}

/** Thrown when a stage parks (claude failed/blocked) so the recorder stops cleanly. */
class StageParked extends Error {}

/**
 * Wait for a human gate to be reachable, then click its approve button. The
 * stage may still be running an agent (no gate visible yet) for many minutes, so
 * we poll the daemon for the target gate stage, then drive the UI button.
 *
 * @param gateStage   the lifecycle stage that parks at this gate
 * @param buttonName  exact accessible name of the approve button
 */
async function clearGate(page: Page, gateStage: string, buttonName: string, maxMs: number) {
  const deadline = Date.now() + maxMs;
  // Poll the daemon for the stage. No reloads needed: the open page subscribes to
  // the task-events SSE stream and refetches its lifecycle state (stage tree,
  // artifacts, gate panel) on every change, so the gate mounts on its own when
  // the stage advances. We poll only to know WHEN to click.
  while (Date.now() < deadline) {
    const { stage, status } = await taskState(page);
    if (stage === gateStage) break;
    // A parked stage (claude failed/blocked) will never reach the gate — stop
    // waiting so the recorder can show the final state instead of spinning.
    if (status === 'failed' || status === 'blocked') {
      throw new StageParked(`task parked at ${stage}/${status} before ${gateStage}`);
    }
    await beat(page, 4000);
  }
  // The gate stage is reached; the SSE refresh mounts the approval panel. Wait
  // for it (no reload), then approve like a human.
  await expect(page.getByRole('heading', { name: 'Approval required' })).toBeVisible({
    timeout: 60_000,
  });
  await beat(page);
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  await beat(page);
}

test('record the workbench driving a task through every gate', async ({ page }) => {
  // --- Open the board, then the task detail (the product's two main surfaces). ---
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Task Board' })).toBeVisible();
  await beat(page);

  await page.goto(`/tasks/${TASK_ID}`);
  await beat(page);

  try {
    // --- GATE 1 — Approve Brief. Approving creates the isolated worktree and kicks
    //     off discovery + planning. ---
    await clearGate(page, 'human_brief_approval', 'Approve Brief', 15 * 60_000);

    // --- GATE 2 — Approve Plan. Only now does the agent get write access; this kicks
    //     off the long implementation + QA-video + self-review run. NOTE: the
    //     `discovery` (Discovery & Plan) stage that precedes this gate does real
    //     codebase exploration against the full enterprise repo and routinely runs
    //     15-20+ min on app/fender; the budget must comfortably exceed that or the
    //     recorder bails mid-run (observed: 17m26s discovery on CORE-242). ---
    await clearGate(page, 'human_plan_approval', 'Approve Plan', 30 * 60_000);

    // --- GATE 3 — Complete review. The build + the agent's own Playwright QA video
    //     are done; surface the Demo Evidence artifact on camera before approving. ---
    await waitAndShowDemoEvidence(page);
    await clearGate(page, 'human_review', 'Complete', 30 * 60_000);

    // --- GATE 4 — Approve Delivery -> publish -> closeout (draft PR for enterprise). ---
    await clearGate(page, 'human_delivery_approval', 'Approve Delivery', 20 * 60_000);

    // Approving only KICKS OFF publish->closeout; the draft PR (delivery.prUrl) is
    // set asynchronously after the click returns. For the enterprise scenario that
    // PR is the whole payoff, so wait for it (or for closeout) before showing the
    // result — otherwise showResult() reads a still-null prUrl and falls through to
    // the diff fallback.
    await waitForDelivery(page, 10 * 60_000);

    // --- Payoff: the task resolves. Linger so the final state is on the recording. ---
    await page.reload();
    await beat(page, 4000);

    // --- Show the BUILT RESULT in the SAME recording, so one .webm contains both the
    //     workbench driving the task AND what it produced. ---
    await showResult(page);
  } catch (err) {
    if (err instanceof StageParked) {
      // claude couldn't finish a stage. Don't crash mid-recording — show the final
      // task state on camera so the .webm ends on something coherent, then surface
      // the failure as a test error AFTER the video is captured.
      console.error(`[recorder] ${err.message}; recording final state`);
      await page.goto(`/tasks/${TASK_ID}`).catch(() => {});
      await beat(page, 5000);
      throw err;
    }
    throw err;
  }
});

/**
 * Drive the same browser to the built result so it lands in the one continuous
 * recording. tictactoe: open the built app and play a move. enterprise (any
 * Linear ticket): open the draft PR. Falls back to the workbench's own diff view
 * when neither is reachable.
 */
async function showResult(page: Page) {
  const detail = await taskDetail(page);
  // resultMode comes from the scenario JSON: "play" opens the built static app and
  // plays a move; "pr" (default) opens the draft PR. Falls back to the diff view.
  const resultMode = process.env.DEMO_RESULT_MODE ?? 'pr';
  const prUrl = detail?.delivery?.prUrl ?? null;
  const worktreePath = detail?.worktree?.worktreePath ?? null;

  // Server-backed play (e.g. Vite dev server + a WS game server reached at a
  // sub-route): boot the servers in the project repo where the merged code lives,
  // wait for the app to serve, navigate to the real URL, demonstrate, tear down.
  // This is the only correct way to show a framework/server app — file:// can't
  // resolve its module imports. Falls through to file:// / PR / diff on any miss.
  if (resultMode === 'play' && process.env.DEMO_PLAY_URL) {
    const shown = await showPlayServer(page);
    if (shown) return;
    console.warn('[recorder] server-backed play did not come up; using fallback');
  }

  const indexPath = worktreePath ? join(worktreePath.replace(/\/+$/, ''), 'index.html') : null;
  if (resultMode === 'play' && indexPath && existsSync(indexPath)) {
    // The built static app lives in the worktree; open it directly (file://) and
    // play a move on camera. The QA harness server is gone by now, so file:// is
    // the no-server way to show the real artifact running.
    await page.goto(`file://${indexPath}`);
    await beat(page, 2000);
    // Play a couple of moves if the grid is keyboard/role accessible (the request
    // asked for getByRole-drivable markup). Best-effort: never fail the recording.
    const cells = page.getByRole('button').or(page.getByRole('gridcell'));
    try {
      const n = Math.min(await cells.count(), 5);
      for (let i = 0; i < n; i++) {
        await cells
          .nth(i)
          .click({ timeout: 3000 })
          .catch(() => {});
        await beat(page, 700);
      }
    } catch {
      /* the grid markup may differ; the static app is still on camera */
    }
    await beat(page, 3000);
    return;
  }

  if (prUrl) {
    // Enterprise payoff: the draft PR on GitHub, in the same session.
    await page.goto(prUrl).catch(() => {});
    await beat(page, 6000);
    return;
  }

  // Fallback: the workbench's own worktree diff for this task.
  await page.goto(`/tasks/${TASK_ID}`);
  const diffBtn = page.getByRole('button', { name: /Diff|Worktree/i }).first();
  if (await diffBtn.count()) {
    await diffBtn.click().catch(() => {});
    await beat(page, 5000);
  } else {
    await beat(page, 4000);
  }
}

/**
 * Boot the project's play servers (DEMO_PLAY_SERVERS, run in DEMO_PLAY_CWD),
 * poll DEMO_PLAY_READY_URL until the app serves, navigate to DEMO_PLAY_URL on
 * camera, and click a few accessible controls best-effort. Always tears the
 * servers down. Returns true if the app was shown, false on any failure (the
 * caller then uses the file:// / PR / diff fallback).
 */
async function showPlayServer(page: Page): Promise<boolean> {
  const url = process.env.DEMO_PLAY_URL as string;
  const readyUrl = process.env.DEMO_PLAY_READY_URL ?? url;
  const cwd = process.env.DEMO_PLAY_CWD;
  let servers: string[] = [];
  try {
    servers = JSON.parse(process.env.DEMO_PLAY_SERVERS ?? '[]');
  } catch {
    servers = [];
  }
  if (!cwd || servers.length === 0) return false;

  const procs: ChildProcess[] = [];
  const kill = () => {
    for (const p of procs) {
      try {
        p.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };

  try {
    for (const cmd of servers) {
      const child = spawn(cmd, { cwd, shell: true, stdio: 'ignore', detached: false });
      procs.push(child);
    }

    // Poll the ready URL until the app serves (dev servers take a beat to bind).
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        const res = await page.request.get(readyUrl, { timeout: 2000 });
        if (res.ok()) up = true;
      } catch {
        /* not yet */
      }
      if (!up) await page.waitForTimeout(1000);
    }
    if (!up) {
      kill();
      return false;
    }

    await page.goto(url, { waitUntil: 'networkidle' }).catch(() => page.goto(url));
    await beat(page, 3000);
    // Best-effort: click a couple of accessible controls so the app is on camera
    // doing something. Never fail the recording over interaction details.
    const buttons = page.getByRole('button');
    try {
      const n = Math.min(await buttons.count(), 3);
      for (let i = 0; i < n; i++) {
        await buttons
          .nth(i)
          .click({ timeout: 2500 })
          .catch(() => {});
        await beat(page, 800);
      }
    } catch {
      /* markup differs; the app is still on camera */
    }
    await beat(page, 3000);
    return true;
  } finally {
    kill();
  }
}

/** Fetch the full task detail bundle from the daemon (tolerant of a transient drop). */
async function taskDetail(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await page.request.get(`${API_BASE}/tasks/${TASK_ID}`, { timeout: 15_000 });
      return res.json();
    } catch {
      await page.waitForTimeout(2000);
    }
  }
  return null;
}

/**
 * After the delivery gate is approved, wait for publish->closeout to finish so the
 * draft PR url (delivery.prUrl) is populated before showResult() reads it. Returns
 * as soon as a prUrl is set OR the task reaches closeout; times out gracefully so a
 * laggy closeout never hangs the recording (showResult still has its diff fallback).
 */
async function waitForDelivery(page: Page, maxMs: number) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const detail = await taskDetail(page);
    const prUrl = detail?.delivery?.prUrl ?? null;
    const stage = detail?.task?.stage ?? '';
    const status = detail?.task?.status ?? '';
    if (prUrl) {
      console.log(`[recorder] delivery prUrl ready: ${prUrl}`);
      return;
    }
    if (stage === 'closeout' || status === 'done' || status === 'completed') {
      console.log(`[recorder] reached ${stage}/${status} (no prUrl)`);
      return;
    }
    if (status === 'failed' || status === 'blocked') {
      console.warn(`[recorder] delivery parked at ${stage}/${status}; showing final state`);
      return;
    }
    await beat(page, 5000);
  }
  console.warn('[recorder] waitForDelivery timed out; falling back to diff view');
}

/** Open the Demo Evidence artifact (the agent's QA video proof) if present. */
async function waitAndShowDemoEvidence(page: Page) {
  // The page refetches over SSE when the artifact is produced, so the button
  // appears on its own — no reload. Wait for it (best-effort), then click.
  const demo = page.getByRole('button', { name: /Demo Evidence/i }).first();
  await demo.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
  if (await demo.count()) {
    await demo.click();
    await beat(page, 3000);
  }
}
