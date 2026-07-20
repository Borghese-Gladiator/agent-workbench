import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Page, ConsoleMessage, Response } from 'playwright';
import { ArtifactStore } from '@awb/evidence';
import type { ArtifactRecord } from '@awb/domain';
import { produceQaEvidence, type QaAssertionResult, type QaEvidenceContext } from './shared.js';

export type BrowserQaStep =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'waitForSelector'; selector: string; timeoutMs?: number }
  | { kind: 'waitForText'; text: string; timeoutMs?: number }
  | { kind: 'screenshot'; name: string }
  | { kind: 'ariaSnapshot'; selector: string };

export interface BrowserQaScenario {
  baseUrl: string;
  steps: BrowserQaStep[];
}

export interface BrowserQaResult {
  assertions: QaAssertionResult[];
  artifacts: ArtifactRecord[];
  consoleErrors: string[];
  failedRequests: string[];
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
      const videoArtifact = await artifactStore.put({
        source: join(videoDir, videoFile),
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
    }
  } finally {
    await browser.close();
    await rm(videoDir, { recursive: true, force: true });
    await rm(join(tracePath, '..'), { recursive: true, force: true });
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

  return { assertions, artifacts, consoleErrors, failedRequests, evidence };
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
      assertions.push({ name: `navigate:${step.url}`, passed: true });
      return;
    }
    case 'click': {
      await page.locator(step.selector).click();
      assertions.push({ name: `click:${step.selector}`, passed: true });
      return;
    }
    case 'type': {
      await page.locator(step.selector).fill(step.text);
      assertions.push({ name: `type:${step.selector}`, passed: true });
      return;
    }
    case 'waitForSelector': {
      await page.locator(step.selector).waitFor({ state: 'visible', timeout: step.timeoutMs });
      assertions.push({ name: `waitForSelector:${step.selector}`, passed: true });
      return;
    }
    case 'waitForText': {
      await page.getByText(step.text).waitFor({ state: 'visible', timeout: step.timeoutMs });
      assertions.push({ name: `waitForText:${step.text}`, passed: true });
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
      assertions.push({ name: `screenshot:${step.name}`, passed: true, detail: artifact.id });
      return;
    }
    case 'ariaSnapshot': {
      const snapshot = await page.locator(step.selector).ariaSnapshot();
      assertions.push({
        name: `ariaSnapshot:${step.selector}`,
        passed: snapshot.length > 0,
        detail: snapshot,
      });
      return;
    }
  }
}
