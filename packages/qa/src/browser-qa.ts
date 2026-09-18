import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Page, ConsoleMessage, Response } from 'playwright';
import { ArtifactStore } from '@awb/evidence';
import type { ArtifactRecord } from '@awb/domain';
import {
  policyBlockingErrorsPresent,
  produceQaEvidence,
  type QaAssertionResult,
  type QaEvidenceContext,
} from './shared.js';
import { transcodeWebmToGif } from './transcode.js';

export type BrowserQaStep =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'waitForSelector'; selector: string; timeoutMs?: number }
  | { kind: 'waitForText'; text: string; timeoutMs?: number }
  | { kind: 'screenshot'; name: string }
  | { kind: 'ariaSnapshot'; selector: string }
  // A pure observation (TASK-131): waits briefly for the selector, then reports what is actually
  // there (visible/text/ariaSnapshot) as a `liveness`-strength assertion that always "passes" — it
  // never itself judges pass/fail. For the qa-executor agent session, which forms its own
  // pass/fail judgement (via `evidence_write`) from what it observes, rather than a code-side
  // expectation deciding it.
  | { kind: 'inspect'; selector: string; timeoutMs?: number }
  // State-transition / value-match steps that observe real behaviour rather than
  // "the action did not throw". `expectVisible`/`expectHidden` assert a post-action DOM state;
  // `expectText` compares an element's text to an expected value.
  // `livenessOnly` downgrades an `expectVisible` to a `liveness` assertion — used for the landmark
  // "the page rendered *some* structural element" check, which proves the page is alive but is NOT
  // a behavioral state transition and so must not be able to cover a behavior claim on its own.
  | { kind: 'expectVisible'; selector: string; timeoutMs?: number; livenessOnly?: boolean }
  | { kind: 'expectHidden'; selector: string; timeoutMs?: number }
  | { kind: 'expectText'; selector: string; equals: string }
  // Repeatable-click socket-idempotency step: click a socket-opening control twice and assert the
  // second click did NOT open a second WebSocket. `settleMs` is how long we wait after each click
  // for a socket to open (the `page.on('websocket')` listener fires asynchronously).
  | { kind: 'expectNoDuplicateSocket'; selector: string; settleMs?: number };

export interface BrowserQaScenario {
  baseUrl: string;
  steps: BrowserQaStep[];
}

export interface BrowserQaResult {
  assertions: QaAssertionResult[];
  artifacts: ArtifactRecord[];
  consoleErrors: string[];
  failedRequests: string[];
  /**
   * Convenience — whether any frontend-observable console/network error (an unhandled console
   * error or a failed/4xx+ network request) should block the gate. Scoped to the console/network
   * surface; transport-level duplicate-socket defects are detected separately via a real
   * `page.on('websocket')` listener and surface as a failing `no-duplicate-socket` assertion
   * (see `socketOpensByInteraction`), NOT through this flag.
   */
  policyBlockingErrorsPresent: boolean;
  /**
   * WebSocket opens observed during each `expectNoDuplicateSocket` interaction — the count of new
   * sockets the second click opened. A value > 0 means a socket-opening control opened a duplicate
   * connection on repeat click, which fails the corresponding assertion.
   */
  socketOpensByInteraction: number[];
  evidence: ReturnType<typeof produceQaEvidence>;
}

/** What `InteractiveBrowserSession.close()` hands back — everything a caller needs to finish its own Evidence. */
export interface ClosedBrowserSession {
  /** Auto-derived failing assertions for every captured console error / failed request. */
  assertions: QaAssertionResult[];
  artifacts: ArtifactRecord[];
  consoleErrors: string[];
  failedRequests: string[];
  policyBlockingErrorsPresent: boolean;
  socketOpensByInteraction: number[];
  videoProduced: boolean;
  traceProduced: boolean;
}

/**
 * One real, live Chromium session a caller drives step-by-step (rather than handing it a whole
 * pre-scripted scenario up front). `runBrowserQa` below is just the scripted-scenario case built on
 * top of this; the TASK-131 qa-executor agent session is the turn-by-turn case — one `runStep` per
 * tool call, `close()` once the agent finishes.
 */
export interface InteractiveBrowserSession {
  runStep(step: BrowserQaStep): Promise<QaAssertionResult>;
  /** Stops tracing/recording, persists whatever artifacts exist, and tears the browser down. Idempotent-safe to call once. */
  close(): Promise<ClosedBrowserSession>;
}

/**
 * Opens one real Chromium browser + context + page (video recording and tracing started
 * immediately, matching `runBrowserQa`'s always-on capture) and returns a handle a caller drives
 * one step at a time. `baseUrl`, when given, resolves a `navigate` step's relative URLs; omit it
 * when every `navigate` step will pass an absolute URL.
 */
export async function openInteractiveBrowserSession(
  context: QaEvidenceContext,
  artifactStore: ArtifactStore,
  options?: { baseUrl?: string },
): Promise<InteractiveBrowserSession> {
  const artifacts: ArtifactRecord[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const socketOpensByInteraction: number[] = [];
  const socketTracker = { totalOpens: 0 };

  const videoDir = await mkdtemp(join(tmpdir(), 'awb-qa-video-'));
  const tracePath = join(await mkdtemp(join(tmpdir(), 'awb-qa-trace-')), 'trace.zip');

  const browser = await chromium.launch();
  const browserContext = await browser.newContext({ recordVideo: { dir: videoDir } });
  await browserContext.tracing.start({ screenshots: true, snapshots: true });

  const page = await browserContext.newPage();
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url()} - ${req.failure()?.errorText ?? 'unknown'}`);
  });
  page.on('response', (res: Response) => {
    if (res.status() >= 400) {
      failedRequests.push(`${res.request().method()} ${res.url()} - ${res.status()}`);
    }
  });
  // Real transport inspection: count every WebSocket the page opens. `expectNoDuplicateSocket`
  // reads this total before/after a repeat click to detect a duplicate connection.
  page.on('websocket', () => {
    socketTracker.totalOpens += 1;
  });

  let closed = false;

  return {
    async runStep(step: BrowserQaStep): Promise<QaAssertionResult> {
      const assertions: QaAssertionResult[] = [];
      await executeStep(
        page,
        options?.baseUrl ?? '',
        step,
        assertions,
        artifactStore,
        context,
        artifacts,
        socketTracker,
        socketOpensByInteraction,
      );
      // executeStep always pushes exactly one assertion per step (see its switch below).
      return assertions[0] as QaAssertionResult;
    },

    async close(): Promise<ClosedBrowserSession> {
      if (closed) {
        return {
          assertions: [],
          artifacts,
          consoleErrors,
          failedRequests,
          policyBlockingErrorsPresent: policyBlockingErrorsPresent({ consoleErrors, failedRequests }),
          socketOpensByInteraction,
          videoProduced: artifacts.some((a) => a.kind === 'qa-video'),
          traceProduced: artifacts.some((a) => a.kind === 'browser-trace'),
        };
      }
      closed = true;

      let videoProduced = false;
      let traceProduced = false;
      try {
        await browserContext.tracing.stop({ path: tracePath });
        await page.close();
        await browserContext.close();

        try {
          const traceArtifact = await artifactStore.put({
            source: tracePath,
            mediaType: 'application/zip',
            kind: 'browser-trace',
            retention: 'task',
            taskId: context.taskId,
            runId: context.runId,
            phaseAttemptId: context.phaseAttemptId,
            candidateSha: context.candidateSha,
          });
          artifacts.push(traceArtifact);
          traceProduced = true;
        } catch {
          traceProduced = false;
        }

        const videoFiles = await readdir(videoDir).catch(() => []);
        const videoFile = videoFiles.find((f) => f.endsWith('.webm'));
        if (videoFile) {
          const webmPath = join(videoDir, videoFile);
          const videoArtifact = await artifactStore.put({
            source: webmPath,
            mediaType: 'video/webm',
            kind: 'qa-video',
            retention: 'task',
            taskId: context.taskId,
            runId: context.runId,
            phaseAttemptId: context.phaseAttemptId,
            candidateSha: context.candidateSha,
          });
          artifacts.push(videoArtifact);
          videoProduced = true;

          // Transcode a downscaled GIF alongside the WEBM so the PR comment can embed the recording
          // inline (GitHub renders a GIF via image markdown but does NOT play a committed .webm). The
          // WEBM stays the full-fidelity source; a transcode failure (e.g. no ffmpeg) is non-fatal —
          // the run keeps the WEBM and simply has no inline GIF.
          const gifPath = join(videoDir, 'recording.gif');
          try {
            await transcodeWebmToGif(webmPath, gifPath);
            const gifArtifact = await artifactStore.put({
              source: gifPath,
              mediaType: 'image/gif',
              kind: 'qa-video-gif',
              retention: 'task',
              taskId: context.taskId,
              runId: context.runId,
              phaseAttemptId: context.phaseAttemptId,
              candidateSha: context.candidateSha,
            });
            artifacts.push(gifArtifact);
          } catch {
            // No GIF; the WEBM link remains the recording artifact.
          }
        }
      } finally {
        await browser.close();
        await rm(videoDir, { recursive: true, force: true });
        await rm(join(tracePath, '..'), { recursive: true, force: true });
      }

      // Surface captured console/network errors as real failing assertions, so a page that throws
      // errors or fails a request fails QA instead of silently passing. Duplicate-socket detection is
      // NOT here — it is an inline `no-duplicate-socket` assertion emitted by the
      // `expectNoDuplicateSocket` step, driven by the real `page.on('websocket')` listener above.
      const assertions: QaAssertionResult[] = [];
      for (const err of consoleErrors) {
        assertions.push({ name: 'no-console-error', passed: false, detail: err, strength: 'state-transition' });
      }
      for (const req of failedRequests) {
        assertions.push({ name: 'no-failed-request', passed: false, detail: req, strength: 'state-transition' });
      }

      return {
        assertions,
        artifacts,
        consoleErrors,
        failedRequests,
        policyBlockingErrorsPresent: policyBlockingErrorsPresent({ consoleErrors, failedRequests }),
        socketOpensByInteraction,
        videoProduced,
        traceProduced,
      };
    },
  };
}

/**
 * Executes a scripted sequence of browser steps against a real (or test-fixture) page using a
 * real chromium instance — no mocking of Playwright. Captures a real video recording, a real
 * trace, and screenshots, all stored via ArtifactStore. Per product spec §23, the returned
 * Evidence.status is derived from the structured per-step assertions plus whether the required
 * video/trace artifacts were actually produced — never from "a video exists" alone.
 */
export async function runBrowserQa(
  scenario: BrowserQaScenario,
  context: QaEvidenceContext,
  artifactStore: ArtifactStore,
): Promise<BrowserQaResult> {
  const session = await openInteractiveBrowserSession(context, artifactStore, { baseUrl: scenario.baseUrl });
  const assertions: QaAssertionResult[] = [];
  let executionErrored = false;

  try {
    for (const step of scenario.steps) {
      assertions.push(await session.runStep(step));
    }
  } catch (err) {
    executionErrored = true;
    assertions.push({
      name: 'browser-scenario-execution',
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const closed = await session.close();
  assertions.push(...closed.assertions);

  const evidence = produceQaEvidence({
    kind: 'qa-video',
    assertions,
    requiredArtifactProduced: closed.videoProduced && closed.traceProduced,
    executionErrored,
    artifactIds: closed.artifacts.map((a) => a.id),
    summary: `Browser QA: ${scenario.steps.length} step(s), ${assertions.filter((a) => a.passed).length}/${assertions.length} assertions passed`,
    context,
  });

  return {
    assertions,
    artifacts: closed.artifacts,
    consoleErrors: closed.consoleErrors,
    failedRequests: closed.failedRequests,
    policyBlockingErrorsPresent: closed.policyBlockingErrorsPresent,
    socketOpensByInteraction: closed.socketOpensByInteraction,
    evidence,
  };
}

async function executeStep(
  page: Page,
  baseUrl: string,
  step: BrowserQaStep,
  assertions: QaAssertionResult[],
  artifactStore: ArtifactStore,
  context: QaEvidenceContext,
  artifacts: ArtifactRecord[],
  socketTracker: { totalOpens: number },
  socketOpensByInteraction: number[],
): Promise<void> {
  switch (step.kind) {
    case 'navigate': {
      const url = step.url.startsWith('http') ? step.url : new URL(step.url, baseUrl).toString();
      await page.goto(url);
      assertions.push({ name: `navigate:${step.url}`, passed: true, strength: 'liveness' });
      return;
    }
    case 'click': {
      await page.locator(step.selector).click();
      assertions.push({ name: `click:${step.selector}`, passed: true, strength: 'liveness' });
      return;
    }
    case 'type': {
      await page.locator(step.selector).fill(step.text);
      assertions.push({ name: `type:${step.selector}`, passed: true, strength: 'liveness' });
      return;
    }
    case 'waitForSelector': {
      await page.locator(step.selector).waitFor({ state: 'visible', timeout: step.timeoutMs });
      assertions.push({ name: `waitForSelector:${step.selector}`, passed: true, strength: 'liveness' });
      return;
    }
    case 'waitForText': {
      await page.getByText(step.text).waitFor({ state: 'visible', timeout: step.timeoutMs });
      assertions.push({ name: `waitForText:${step.text}`, passed: true, strength: 'liveness' });
      return;
    }
    case 'expectVisible': {
      // A genuine post-action state assertion — the element became visible. `.first()` so a grouped
      // selector (e.g. `h1, header, main`) checks "at least one such element is visible" instead of
      // tripping Playwright strict mode on multiple matches.
      let visible = false;
      try {
        await page.locator(step.selector).first().waitFor({ state: 'visible', timeout: step.timeoutMs ?? 5000 });
        visible = true;
      } catch {
        visible = false;
      }
      assertions.push({
        name: `expectVisible:${step.selector}`,
        passed: visible,
        strength: step.livenessOnly ? 'liveness' : 'state-transition',
      });
      return;
    }
    case 'expectHidden': {
      let hidden = false;
      try {
        await page.locator(step.selector).waitFor({ state: 'hidden', timeout: step.timeoutMs ?? 5000 });
        hidden = true;
      } catch {
        hidden = false;
      }
      assertions.push({ name: `expectHidden:${step.selector}`, passed: hidden, strength: 'state-transition' });
      return;
    }
    case 'expectText': {
      // A value comparison — the observed text equals the expected value.
      const actual = (await page.locator(step.selector).textContent())?.trim() ?? '';
      assertions.push({
        name: `expectText:${step.selector}`,
        passed: actual === step.equals,
        detail: `expected "${step.equals}", got "${actual}"`,
        strength: 'value-match',
      });
      return;
    }
    case 'expectNoDuplicateSocket': {
      // Socket idempotency: click a socket-opening control twice; the second click must NOT open a
      // second WebSocket. First click primes the connection; we then snapshot the running open count,
      // click again, wait for any late socket to fire, and assert no new socket opened.
      const settleMs = step.settleMs ?? 500;
      const control = page.locator(step.selector);
      await control.click();
      await page.waitForTimeout(settleMs);
      const before = socketTracker.totalOpens;
      await control.click();
      await page.waitForTimeout(settleMs);
      const opensOnRepeat = socketTracker.totalOpens - before;
      socketOpensByInteraction.push(opensOnRepeat);
      assertions.push({
        name: `no-duplicate-socket:${step.selector}`,
        passed: opensOnRepeat === 0,
        detail:
          opensOnRepeat === 0
            ? 'repeat click opened no additional WebSocket'
            : `repeat click opened ${opensOnRepeat} additional WebSocket(s) — duplicate connection`,
        strength: 'state-transition',
      });
      return;
    }
    case 'screenshot': {
      const buffer = await page.screenshot();
      const artifact = await artifactStore.put({
        source: buffer,
        mediaType: 'image/png',
        kind: 'screenshot',
        retention: 'task',
        taskId: context.taskId,
        runId: context.runId,
        phaseAttemptId: context.phaseAttemptId,
        candidateSha: context.candidateSha,
      });
      artifacts.push(artifact);
      assertions.push({ name: `screenshot:${step.name}`, passed: true, detail: artifact.id, strength: 'liveness' });
      return;
    }
    case 'ariaSnapshot': {
      const snapshot = await page.locator(step.selector).ariaSnapshot();
      assertions.push({
        name: `ariaSnapshot:${step.selector}`,
        passed: snapshot.length > 0,
        detail: snapshot,
        strength: 'liveness',
      });
      return;
    }
    case 'inspect': {
      const locator = page.locator(step.selector).first();
      let visible = false;
      try {
        await locator.waitFor({ state: 'visible', timeout: step.timeoutMs ?? 3000 });
        visible = true;
      } catch {
        visible = false;
      }
      const text = visible ? ((await locator.textContent().catch(() => null))?.trim() ?? '') : '';
      const ariaSnapshot = visible ? await locator.ariaSnapshot().catch(() => '') : '';
      assertions.push({
        name: `inspect:${step.selector}`,
        passed: true,
        detail: JSON.stringify({ visible, text, ariaSnapshot }),
        strength: 'liveness',
      });
      return;
    }
  }
}
