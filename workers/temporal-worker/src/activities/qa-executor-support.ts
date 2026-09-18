import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { runCommand, killProcessTree } from '@awb/execution';
import { runIdForTask } from '@awb/database';
import { withSpan } from '@awb/telemetry';
import type { ArtifactStore } from '@awb/evidence';
import type { CodingAgentAdapter, AgentEventSink } from '@awb/agent-gateway';
import { tool, sdkMcpToolName } from '@awb/agent-gateway';
import type { AcceptanceClaim, ArtifactRecord, Evidence, ExpectedAssertion, ModelUsage } from '@awb/domain';
import {
  openInteractiveBrowserSession,
  produceQaEvidence,
  type InteractiveBrowserSession,
  type QaAssertionResult,
  type QaEvidenceContext,
} from '@awb/qa';

/**
 * TASK-131: the `exercise` phase's real QA executor — one agent session, scoped to the
 * `qa-executor` role, given tool-bridged primitives instead of the retired
 * browser/cli-run/http-api/library/cli-default dispatch ladder (`qa-mode.ts`, deleted). The agent
 * decides which tools to reach for; it does NOT decide whether QA passed — `evidence_write` is the
 * only way this produces a result, and `evaluateExercise` (unchanged) is what actually gates on it.
 */

function textToolResult(value: unknown, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    isError,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The worker's own environment, filtered to defined string values — commands need a real PATH to resolve npm/pnpm/node/etc. */
function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** A bounded capture of a spawned process's stdout/stderr, so a chatty dev server can't flood memory. Moved here from the retired `browser-qa-support.ts`. */
interface ServerLogHandle {
  text(): string;
  exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
}

function attachServerLog(child: ChildProcess, maxBytes = 64 * 1024): ServerLogHandle {
  const chunks: Buffer[] = [];
  let size = 0;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  const append = (buf: Buffer): void => {
    chunks.push(buf);
    size += buf.length;
    while (size > maxBytes && chunks.length > 1) {
      const dropped = chunks.shift();
      if (dropped) size -= dropped.length;
    }
  };

  child.stdout?.on('data', (d: Buffer) => append(Buffer.from(d)));
  child.stderr?.on('data', (d: Buffer) => append(Buffer.from(d)));
  child.on('exit', (code, signal) => {
    exit = { code, signal };
  });

  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    exitInfo: () => exit,
  };
}

/** The same URL with the host swapped between `localhost` and `127.0.0.1` (a Vite-style dev server may bind only one). */
function localhostVariants(url: string): string[] {
  if (url.includes('localhost')) return [url.replace('localhost', '127.0.0.1')];
  if (url.includes('127.0.0.1')) return [url.replace('127.0.0.1', 'localhost')];
  return [];
}

/** Probes a URL until it responds, or the process exits first (a crash). */
async function waitForServer(url: string, timeoutMs: number, processExited: () => boolean): Promise<string | undefined> {
  const candidates = [url, ...localhostVariants(url)];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processExited()) return undefined;
    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate);
        if (res.ok || res.status < 500) return candidate;
      } catch {
        // not up yet
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

function resolveReadinessTimeoutMs(explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  const raw = process.env.AWB_QA_READINESS_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 30_000) return parsed;
  return 90_000;
}

/**
 * Renders the qa-executor's instruction: the behavioral claims to validate (with the planner's
 * expected per-claim observations, when any were authored), a non-binding start-command hint, and
 * the tool contract — evidence_write is the only thing that produces a result. Exported for unit
 * testing the rendering without a live session.
 */
export function buildQaExecutorInstruction(input: {
  claims: AcceptanceClaim[];
  expectedAssertionsByClaim: Record<string, ExpectedAssertion[]>;
  startCommandHint?: { command: string; baseUrl?: string };
}): string {
  const claimLines = input.claims.map((claim) => {
    const expected = input.expectedAssertionsByClaim[claim.id] ?? [];
    const expectedText =
      expected.length > 0
        ? ` Expected observation(s): ${expected.map((e) => `${e.kind}: ${e.observes}`).join('; ')}.`
        : '';
    return `- [${claim.id}] ${claim.description}${expectedText}`;
  });

  const hint = input.startCommandHint
    ? `A previously-resolved run command for this repo: \`${input.startCommandHint.command}\`` +
      `${input.startCommandHint.baseUrl ? ` (expected to serve ${input.startCommandHint.baseUrl})` : ''}. ` +
      'This is a HINT, not a guarantee — verify it yourself, and find your own way if it does not work.'
    : 'No previously-resolved run command is known for this repo — find your own way to run or serve it ' +
      '(inspect the worktree with terminal_interact if you need to).';

  return [
    'You are validating a candidate change to a real repository, checked out at your current working directory.',
    'Validate these behavioral claims for real, using your tools — do not assume, and do not fabricate a pass:',
    ...claimLines,
    hint,
    'Tools: terminal_interact (run one shell command, see its output); application_start / application_stop ' +
      '(run a long-lived process such as a dev server, and wait for it to become ready at a URL); http_request ' +
      '(make a real HTTP request); browser_navigate / browser_click / browser_type / browser_inspect / ' +
      'browser_screenshot (drive a real Chromium browser against a URL and observe the page).',
    'When you are done — whether every claim validated, some failed, or you could not find a way to validate at ' +
      'all — call evidence_write EXACTLY ONCE with your final list of assertions and a summary. That call is the ' +
      'ONLY thing that determines the result; nothing else you do matters unless you call it. An honest failing ' +
      'or inconclusive assertion (e.g. "no server could be started") is a legitimate result — never report ' +
      'passed: true for something you did not actually observe.',
  ].join('\n\n');
}

export interface QaExecutorSessionInput {
  adapter: CodingAgentAdapter;
  taskId: string;
  worktreePath: string;
  context: QaEvidenceContext;
  artifactStore: ArtifactStore;
  claims: AcceptanceClaim[];
  expectedAssertionsByClaim: Record<string, ExpectedAssertion[]>;
  startCommandHint?: { command: string; baseUrl?: string };
  disallowedTools?: string[];
  tokenBudget: number;
  runtimeBudgetMs: number;
  eventSink: AgentEventSink;
  resumeSessionId?: string;
}

export interface QaExecutorSessionResult {
  assertions: QaAssertionResult[];
  artifacts: ArtifactRecord[];
  policyBlockingErrorsPresent: boolean;
  evidence: Evidence;
  usage?: ModelUsage;
  runtimeMs: number;
  sessionId?: string;
  /** A run command the agent itself found working via `application_start`, if any — the caller may cache it for the next run, same as the retired ladder's Tier-1 write-back. */
  discoveredStartCommand?: { command: string; baseUrl: string };
}

/** One real qa-executor session (Stage 3): builds the tool bridge, runs the agent, and finalizes whatever it produced into the same shape the retired dispatch ladder returned. */
export async function runQaExecutorSession(input: QaExecutorSessionInput): Promise<QaExecutorSessionResult> {
  return withSpan(
    'session.qa-executor',
    { run_id: runIdForTask(input.taskId), task_id: input.taskId, phase: 'exercise' },
    () => runSession(input),
  );
}

async function runSession(input: QaExecutorSessionInput): Promise<QaExecutorSessionResult> {
  let browserSession: InteractiveBrowserSession | undefined;
  let usedBrowser = false;
  const app: { child?: ChildProcess; log?: ServerLogHandle } = {};
  let discoveredStartCommand: { command: string; baseUrl: string } | undefined;
  const toolTranscript: string[] = [];
  let submittedAssertions: QaAssertionResult[] | undefined;
  let submittedSummary: string | undefined;

  const tools = [
    tool('browser_navigate', 'Navigate the QA browser to a URL (relative URLs resolve against the app base URL, if one is known).', { url: z.string() }, async ({ url }) => {
      try {
        if (!browserSession) {
          browserSession = await openInteractiveBrowserSession(input.context, input.artifactStore, {
            baseUrl: input.startCommandHint?.baseUrl,
          });
          usedBrowser = true;
        }
        const result = await browserSession.runStep({ kind: 'navigate', url });
        toolTranscript.push(`browser_navigate(${url}) -> ${JSON.stringify(result)}`);
        return textToolResult(result);
      } catch (err) {
        return textToolResult(errorText(err), true);
      }
    }),

    tool('browser_click', 'Click an element in the QA browser (CSS selector).', { selector: z.string() }, async ({ selector }) => {
      try {
        if (!browserSession) return textToolResult('no browser session is open — call browser_navigate first', true);
        const result = await browserSession.runStep({ kind: 'click', selector });
        toolTranscript.push(`browser_click(${selector}) -> ${JSON.stringify(result)}`);
        return textToolResult(result);
      } catch (err) {
        return textToolResult(errorText(err), true);
      }
    }),

    tool('browser_type', 'Type text into an input in the QA browser (CSS selector).', { selector: z.string(), text: z.string() }, async ({ selector, text }) => {
      try {
        if (!browserSession) return textToolResult('no browser session is open — call browser_navigate first', true);
        const result = await browserSession.runStep({ kind: 'type', selector, text });
        toolTranscript.push(`browser_type(${selector}) -> ${JSON.stringify(result)}`);
        return textToolResult(result);
      } catch (err) {
        return textToolResult(errorText(err), true);
      }
    }),

    tool(
      'browser_inspect',
      'Observe an element in the QA browser: whether it is visible, its text content, and its accessibility (aria) snapshot. A pure observation — it never judges pass/fail for you.',
      { selector: z.string(), timeoutMs: z.number().optional() },
      async ({ selector, timeoutMs }) => {
        try {
          if (!browserSession) return textToolResult('no browser session is open — call browser_navigate first', true);
          const result = await browserSession.runStep({ kind: 'inspect', selector, timeoutMs });
          toolTranscript.push(`browser_inspect(${selector}) -> ${result.detail ?? ''}`);
          return textToolResult(JSON.parse(result.detail ?? '{}'));
        } catch (err) {
          return textToolResult(errorText(err), true);
        }
      },
    ),

    tool('browser_screenshot', 'Take a screenshot of the current QA browser page and store it as evidence.', { name: z.string() }, async ({ name }) => {
      try {
        if (!browserSession) return textToolResult('no browser session is open — call browser_navigate first', true);
        const result = await browserSession.runStep({ kind: 'screenshot', name });
        toolTranscript.push(`browser_screenshot(${name}) -> ${JSON.stringify(result)}`);
        return textToolResult(result);
      } catch (err) {
        return textToolResult(errorText(err), true);
      }
    }),

    tool(
      'terminal_interact',
      'Run one shell command to completion in the task worktree and observe its exit code, stdout, and stderr.',
      { command: z.string(), cwd: z.string().optional(), timeoutMs: z.number().optional() },
      async ({ command, cwd, timeoutMs }) => {
        const result = await runCommand({
          command: 'sh',
          args: ['-c', command],
          cwd: cwd ?? input.worktreePath,
          env: inheritedEnv(),
          timeoutMs: timeoutMs ?? 120_000,
        });
        toolTranscript.push(
          `$ ${command}\ncwd: ${result.cwd}\nexitCode: ${result.exitCode ?? 'null'}\ntimedOut: ${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
        return textToolResult({ exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr });
      },
    ),

    tool(
      'application_start',
      'Start a long-running process (e.g. a dev server) in the task worktree and, when a baseUrl is given, wait for it to become ready there. Only one application may run at a time — call application_stop before starting another.',
      { command: z.string(), baseUrl: z.string().optional(), readinessTimeoutMs: z.number().optional() },
      async ({ command, baseUrl, readinessTimeoutMs }) => {
        if (app.child) {
          return textToolResult({ ok: false, reason: 'an application is already running — call application_stop first' }, true);
        }
        const child = spawn(command, {
          cwd: input.worktreePath,
          shell: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        app.child = child;
        app.log = attachServerLog(child);
        toolTranscript.push(`application_start(${command})`);
        if (!baseUrl) {
          return textToolResult({ ok: true, note: 'started; no baseUrl given, so readiness was not probed' });
        }
        const readyUrl = await waitForServer(baseUrl, resolveReadinessTimeoutMs(readinessTimeoutMs), () => app.log?.exitInfo() !== undefined);
        if (!readyUrl) {
          const exit = app.log?.exitInfo();
          const reason = exit
            ? `process exited (code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'null'}) before serving ${baseUrl}`
            : `did not become ready at ${baseUrl} within ${resolveReadinessTimeoutMs(readinessTimeoutMs)}ms`;
          return textToolResult({ ok: false, reason, logTail: app.log?.text().slice(-4000) }, true);
        }
        discoveredStartCommand = { command, baseUrl: readyUrl };
        return textToolResult({ ok: true, readyUrl });
      },
    ),

    tool('application_stop', 'Stop the application started via application_start, if one is running.', {}, async () => {
      if (!app.child?.pid) return textToolResult({ ok: true, note: 'nothing running' });
      try {
        killProcessTree(app.child.pid, 'SIGKILL');
      } catch {
        // best-effort
      }
      app.child = undefined;
      app.log = undefined;
      toolTranscript.push('application_stop()');
      return textToolResult({ ok: true });
    }),

    tool(
      'http_request',
      'Make one real HTTP request and observe the response status, headers, and body.',
      { method: z.string().optional(), url: z.string(), headers: z.record(z.string()).optional(), body: z.string().optional() },
      async ({ method, url, headers, body }) => {
        try {
          const res = await fetch(url, { method: method ?? 'GET', headers, body });
          const text = await res.text();
          toolTranscript.push(`http_request(${method ?? 'GET'} ${url}) -> ${res.status}`);
          return textToolResult({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: text.slice(0, 4000) });
        } catch (err) {
          return textToolResult(errorText(err), true);
        }
      },
    ),

    tool(
      'evidence_write',
      'Submit your FINAL structured QA result. Call this exactly once, after you finished validating (or determined you could not validate) the behavioral claims. This is the only thing that determines the result.',
      {
        assertions: z.array(
          z.object({
            name: z.string(),
            passed: z.boolean(),
            detail: z.string().optional(),
            strength: z.enum(['liveness', 'state-transition', 'value-match']).optional(),
          }),
        ),
        summary: z.string(),
      },
      async ({ assertions, summary }) => {
        submittedAssertions = assertions;
        submittedSummary = summary;
        return textToolResult({ ok: true, recorded: assertions.length });
      },
    ),
  ];

  const allowedTools = tools.map((t) => sdkMcpToolName(t.name));

  const session = await input.adapter.createSession({
    role: 'qa-executor',
    taskId: input.taskId,
    cwd: input.worktreePath,
    contextPayload: { claims: input.claims, expectedAssertionsByClaim: input.expectedAssertionsByClaim },
    allowedTools,
    disallowedTools: input.disallowedTools,
    tools,
    resumeSessionId: input.resumeSessionId,
  });

  let execution: { completed: boolean; usage?: ModelUsage; summary: string; sessionId?: string };
  // Set once, in the `finally` below, on BOTH the success and the throw path — a hard SDK failure
  // must not leave the browser/app process running through however many Temporal retries follow.
  let closedBrowser: Awaited<ReturnType<InteractiveBrowserSession['close']>> | undefined;
  const startedAt = Date.now();
  try {
    const instruction = buildQaExecutorInstruction({
      claims: input.claims,
      expectedAssertionsByClaim: input.expectedAssertionsByClaim,
      startCommandHint: input.startCommandHint,
    });
    execution = await input.adapter.execute(
      session,
      { instruction, stopConditions: { maxTurns: 40, maxTokens: input.tokenBudget, maxWallClockMs: input.runtimeBudgetMs } },
      input.eventSink,
      new AbortController().signal,
    );
  } finally {
    // Best-effort cleanup: an application the agent forgot to stop must not leak past this phase.
    if (app.child?.pid) {
      try {
        killProcessTree(app.child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    if (browserSession) {
      try {
        closedBrowser = await browserSession.close();
      } catch {
        closedBrowser = undefined;
      }
    }
    await input.adapter.dispose(session);
  }
  const runtimeMs = Date.now() - startedAt;

  const executionErrored = !execution.completed || submittedAssertions === undefined;
  const assertions: QaAssertionResult[] = submittedAssertions ? [...submittedAssertions] : [];
  if (submittedAssertions === undefined) {
    assertions.push({
      name: 'qa-executor-no-evidence-submitted',
      passed: false,
      detail: `the qa-executor session ended (completed=${execution.completed}) without calling evidence_write`,
    });
  }
  if (closedBrowser) assertions.push(...closedBrowser.assertions);

  const artifacts: ArtifactRecord[] = closedBrowser ? [...closedBrowser.artifacts] : [];
  let transcriptProduced = false;
  if (toolTranscript.length > 0) {
    try {
      const transcriptArtifact = await input.artifactStore.put({
        source: Buffer.from(toolTranscript.join('\n\n'), 'utf8'),
        mediaType: 'text/plain',
        kind: 'terminal-recording',
        retention: 'task',
        taskId: input.context.taskId,
        runId: input.context.runId,
        phaseAttemptId: input.context.phaseAttemptId,
        candidateSha: input.context.candidateSha,
      });
      artifacts.push(transcriptArtifact);
      transcriptProduced = true;
    } catch {
      transcriptProduced = false;
    }
  }

  const requiredArtifactProduced = usedBrowser
    ? Boolean(closedBrowser?.videoProduced && closedBrowser?.traceProduced)
    : transcriptProduced;

  const evidence = produceQaEvidence({
    kind: usedBrowser ? 'qa-video' : 'terminal-recording',
    assertions,
    requiredArtifactProduced,
    executionErrored,
    artifactIds: artifacts.map((a) => a.id),
    summary: submittedSummary ?? execution.summary,
    context: input.context,
  });

  return {
    assertions,
    artifacts,
    policyBlockingErrorsPresent: closedBrowser?.policyBlockingErrorsPresent ?? false,
    evidence,
    usage: execution.usage,
    runtimeMs,
    sessionId: execution.sessionId,
    discoveredStartCommand,
  };
}
