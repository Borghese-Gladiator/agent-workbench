import { ArtifactStore } from '@awb/evidence';
import type { ArtifactRecord } from '@awb/domain';
import { produceQaEvidence, type QaAssertionResult, type QaEvidenceContext } from './shared.js';

export type HttpApiExpectation =
  | { kind: 'status'; equals: number }
  | { kind: 'bodyContains'; text: string }
  | { kind: 'headerEquals'; header: string; value: string };

export interface HttpApiRequestScenario {
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
  expectations: HttpApiExpectation[];
}

export interface HttpApiQaScenario {
  baseUrl: string;
  requests: HttpApiRequestScenario[];
}

export interface HttpApiQaResult {
  assertions: QaAssertionResult[];
  artifacts: ArtifactRecord[];
  evidence: ReturnType<typeof produceQaEvidence>;
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie']);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return redacted;
}

/**
 * Executes a scripted sequence of real HTTP requests (Node's built-in fetch — no mocking)
 * against a base URL and evaluates structured expectations against the real response. Request
 * and response headers that look like credentials (Authorization/Cookie/Set-Cookie) are redacted
 * to "[redacted]" before being written into the stored evidence log, per product spec §28's
 * secret-scanning spirit (full §28 secret scanning is out of scope here).
 */
export async function runHttpApiQa(
  scenario: HttpApiQaScenario,
  context: QaEvidenceContext,
  artifactStore: ArtifactStore,
): Promise<HttpApiQaResult> {
  const assertions: QaAssertionResult[] = [];
  const artifacts: ArtifactRecord[] = [];
  const logLines: string[] = [];
  let executionErrored = false;

  for (const req of scenario.requests) {
    const url = new URL(req.path, scenario.baseUrl).toString();
    try {
      const response = await fetch(url, {
        method: req.method,
        body: req.body,
        headers: req.headers,
      });
      const bodyText = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      logLines.push(
        JSON.stringify({
          request: {
            method: req.method,
            path: req.path,
            headers: redactHeaders(req.headers ?? {}),
            body: req.body,
          },
          response: {
            status: response.status,
            headers: redactHeaders(responseHeaders),
            body: bodyText,
          },
        }),
      );

      for (const expectation of req.expectations) {
        assertions.push(evaluateExpectation(expectation, response.status, bodyText, responseHeaders, req.path));
      }
    } catch (err) {
      executionErrored = true;
      assertions.push({
        name: `request:${req.method} ${req.path}`,
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let logProduced = false;
  try {
    const logArtifact = await artifactStore.put({
      source: Buffer.from(logLines.join('\n'), 'utf8'),
      mediaType: 'application/x-ndjson',
      kind: 'command-log',
      retention: 'task',
      taskId: context.taskId,
      runId: context.runId,
      phaseAttemptId: context.phaseAttemptId,
      candidateSha: context.candidateSha,
    });
    artifacts.push(logArtifact);
    logProduced = true;
  } catch {
    logProduced = false;
  }

  const evidence = produceQaEvidence({
    kind: 'static-check',
    assertions,
    requiredArtifactProduced: logProduced,
    executionErrored,
    artifactIds: artifacts.map((a) => a.id),
    summary: `HTTP API QA: ${scenario.requests.length} request(s), ${assertions.filter((a) => a.passed).length}/${assertions.length} assertions passed`,
    context,
  });

  return { assertions, artifacts, evidence };
}

function evaluateExpectation(
  expectation: HttpApiExpectation,
  status: number,
  body: string,
  headers: Record<string, string>,
  path: string,
): QaAssertionResult {
  switch (expectation.kind) {
    case 'status':
      return {
        name: `${path}:status=${expectation.equals}`,
        passed: status === expectation.equals,
        detail: `actual status=${status}`,
      };
    case 'bodyContains':
      return {
        name: `${path}:bodyContains:${expectation.text}`,
        passed: body.includes(expectation.text),
      };
    case 'headerEquals': {
      const actual = headers[expectation.header.toLowerCase()];
      return {
        name: `${path}:header:${expectation.header}=${expectation.value}`,
        passed: actual === expectation.value,
        detail: `actual=${actual ?? 'undefined'}`,
      };
    }
  }
}
