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
  // State-transition / value-match steps that observe real behaviour rather than
  // "the action did not throw". `expectVisible`/`expectHidden` assert a post-action DOM state;
  // `expectText` compares an element's text to an expected value.
  | { kind: 'expectVisible'; selector: string; timeoutMs?: number }
  | { kind: 'expectHidden'; selector: string; timeoutMs?: number }
  | { kind: 'expectText'; selector: string; equals: string };

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
   * Convenience — whether any frontend-observable error (an unhandled console error or a
   * failed/4xx+ network request) should block the gate. We do NOT inspect the transport (e.g.
   * WebSocket) directly: QA validates the frontend's observable behaviour and lets the app make
   * whatever connections it makes. A transport-level bug (e.g. a duplicate socket) is caught via
   * its observable symptom — a console/network error, or a failing state/value assertion.
   */
  policyBlockingErrorsPresent: boolean;
  evidence: ReturnType<typeof produceQaEvidence>;
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
  const assertions: QaAssertionResult[] = [];
  const artifacts: ArtifactRecord[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let executionErrored = false;
  let videoProduced = false;
  let traceProduced = false;

  const videoDir = await mkdtemp(join(tmpdir(), 'awb-qa-video-'));
  const tracePath = join(await mkdtemp(join(tmpdir(), 'awb-qa-trace-')), 'trace.zip');

  const browser = await chromium.launch();
  try {
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

    try {
      for (const step of scenario.steps) {
        await executeStep(page, scenario.baseUrl, step, assertions, artifactStore, context, artifacts);
      }
    } catch (err) {
      executionErrored = true;
      assertions.push({
        name: 'browser-scenario-execution',
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

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

  // Surface captured console/network errors and socket leaks as real failing
  // assertions, so a page that throws errors or opens duplicate sockets fails QA instead of
  // silently passing.
  for (const err of consoleErrors) {
    assertions.push({ name: 'no-console-error', passed: false, detail: err, strength: 'state-transition' });
  }
  for (const req of failedRequests) {
    assertions.push({ name: 'no-failed-request', passed: false, detail: req, strength: 'state-transition' });
  }

  const evidence = produceQaEvidence({
    kind: 'qa-video',
    assertions,
    requiredArtifactProduced: videoProduced && traceProduced,
    executionErrored,
    artifactIds: artifacts.map((a) => a.id),
    summary: `Browser QA: ${scenario.steps.length} step(s), ${assertions.filter((a) => a.passed).length}/${assertions.length} assertions passed`,
    context,
  });

  return {
    assertions,
    artifacts,
    consoleErrors,
    failedRequests,
    policyBlockingErrorsPresent: policyBlockingErrorsPresent({ consoleErrors, failedRequests }),
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
      assertions.push({ name: `expectVisible:${step.selector}`, passed: visible, strength: 'state-transition' });
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
  }
}
