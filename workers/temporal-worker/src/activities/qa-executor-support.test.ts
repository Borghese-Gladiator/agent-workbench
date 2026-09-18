// TASK-131: the qa-executor session replaces the retired browser/cli-run/http-api/library/
// cli-default dispatch ladder. These tests exercise the tool bridge end to end — including the
// real completion gate (@awb/workflow evaluatePhaseCompletion), the same way qa-gate-proof.test.ts
// proves the retired runBrowserQa path — via a fake adapter that actually invokes the granted
// tools (the real MockAgentAdapter never calls a tool; it just returns a scripted turn).
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import { evaluateBehavioralClaimCoverage } from '@awb/qa';
import { evaluatePhaseCompletion } from '@awb/workflow';
import type {
  AgentAssignment,
  AgentEventSink,
  AgentExecutionResult,
  AgentSession,
  CodingAgentAdapter,
  CreateAgentSessionInput,
} from '@awb/agent-gateway';
import type { AcceptanceClaim } from '@awb/domain';
import { buildQaExecutorInstruction, runQaExecutorSession } from './qa-executor-support.js';

interface ScriptedToolCall {
  name: string;
  args: unknown;
}

interface FakeToolDefinition {
  name: string;
  handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}

/**
 * A `CodingAgentAdapter` that actually invokes the custom tools a caller granted via
 * `CreateAgentSessionInput.tools` — a scripted sequence of tool calls, in order — unlike
 * `MockAgentAdapter`, which ignores `tools` entirely and only replays a canned final result.
 */
class ToolInvokingFakeAdapter implements CodingAgentAdapter {
  readonly id = 'fake-tool-invoking';
  createSessionCalls: CreateAgentSessionInput[] = [];
  toolResults: Array<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> = [];
  private tools: FakeToolDefinition[] = [];

  constructor(private readonly script: ScriptedToolCall[]) {}

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    this.createSessionCalls.push(input);
    this.tools = (input.tools ?? []) as FakeToolDefinition[];
    return { id: randomUUID(), role: input.role, taskId: input.taskId, providerId: this.id, createdAt: new Date().toISOString() };
  }

  async execute(_session: AgentSession, _assignment: AgentAssignment, _eventSink: AgentEventSink, _signal: AbortSignal): Promise<AgentExecutionResult> {
    for (const step of this.script) {
      const tool = this.tools.find((t) => t.name === step.name);
      if (!tool) throw new Error(`fake adapter: no tool named ${step.name} was granted`);
      const result = await tool.handler(step.args, undefined);
      this.toolResults.push(result);
    }
    return { completed: true, findings: [], summary: 'fake session completed' };
  }

  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}
}

const CLAIM_ID = 'claim-behavior-1';
const CLAIM: AcceptanceClaim = {
  id: CLAIM_ID,
  description: 'clicking Join reveals the room panel',
  category: 'behavior',
  deterministicEvidenceRequired: false,
  qaEvidenceRequired: true,
  humanJudgmentRequired: false,
};

function makeContext(candidateSha: string) {
  return {
    taskId: `task-${candidateSha}`,
    runId: 'run',
    phaseAttemptId: 'exercise-1',
    repositorySnapshotId: 'snap',
    contractVersion: 1,
    candidateSha,
    policyVersion: 'v1',
    claimIds: [CLAIM_ID],
  };
}

describe('runQaExecutorSession (TASK-131)', () => {
  let root: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'awb-qa-executor-'));
    store = new ArtifactStore(root, new InMemoryArtifactMetadataStore());
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the session with role: qa-executor', async () => {
    const adapter = new ToolInvokingFakeAdapter([{ name: 'evidence_write', args: { assertions: [], summary: 'noop' } }]);
    await runQaExecutorSession({
      adapter,
      taskId: 'task-1',
      worktreePath: process.cwd(),
      context: makeContext('sha-1'),
      artifactStore: store,
      claims: [CLAIM],
      expectedAssertionsByClaim: {},
      tokenBudget: 1000,
      runtimeBudgetMs: 5000,
      eventSink: () => {},
    });
    expect(adapter.createSessionCalls).toHaveLength(1);
    expect(adapter.createSessionCalls[0]?.role).toBe('qa-executor');
    expect(adapter.createSessionCalls[0]?.cwd).toBe(process.cwd());
  });

  it('never reports a silent pass when the session ends without calling evidence_write', async () => {
    const adapter = new ToolInvokingFakeAdapter([]); // no tool calls at all
    const result = await runQaExecutorSession({
      adapter,
      taskId: 'task-2',
      worktreePath: process.cwd(),
      context: makeContext('sha-2'),
      artifactStore: store,
      claims: [CLAIM],
      expectedAssertionsByClaim: {},
      tokenBudget: 1000,
      runtimeBudgetMs: 5000,
      eventSink: () => {},
    });
    expect(result.assertions.some((a) => a.name === 'qa-executor-no-evidence-submitted' && a.passed === false)).toBe(true);
    expect(result.evidence.status).toBe('inconclusive');
  });

  it('application_start on a command that never becomes ready returns { ok: false } instead of throwing', async () => {
    const adapter = new ToolInvokingFakeAdapter([
      { name: 'application_start', args: { command: 'sleep 5', baseUrl: 'http://127.0.0.1:1', readinessTimeoutMs: 300 } },
      { name: 'evidence_write', args: { assertions: [{ name: 'no-server', passed: false, detail: 'never became ready' }], summary: 'blocked' } },
    ]);
    await runQaExecutorSession({
      adapter,
      taskId: 'task-3',
      worktreePath: process.cwd(),
      context: makeContext('sha-3'),
      artifactStore: store,
      claims: [CLAIM],
      expectedAssertionsByClaim: {},
      tokenBudget: 1000,
      runtimeBudgetMs: 5000,
      eventSink: () => {},
    });
    const startResult = adapter.toolResults[0];
    expect(startResult?.isError).toBe(true);
    const parsed = JSON.parse(startResult?.content[0]?.text ?? '{}');
    expect(parsed.ok).toBe(false);
  });

  describe('feeding a real browser-driven result into the real completion gate', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      server = createServer((req, res) => {
        const broken = req.url?.startsWith('/broken');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          broken
            ? `<button id="join">Join</button><div id="revealed"></div>`
            : `<button id="join" onclick="document.getElementById('revealed').textContent='Revealed Text'">Join</button><div id="revealed"></div>`,
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no address');
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    });

    async function driveAndGate(path: string, observedText: string) {
      const candidateSha = `sha-${path.replace(/\W/g, '')}`;
      const adapter = new ToolInvokingFakeAdapter([
        { name: 'browser_navigate', args: { url: `${baseUrl}${path}` } },
        { name: 'browser_click', args: { selector: '#join' } },
        { name: 'browser_inspect', args: { selector: '#revealed' } },
        {
          name: 'evidence_write',
          args: {
            assertions: [
              {
                name: 'join-reveals-panel',
                passed: observedText === 'Revealed Text',
                detail: `observed "${observedText}"`,
                strength: 'value-match',
              },
            ],
            summary: 'checked the Join button behavior',
          },
        },
      ]);
      const context = makeContext(candidateSha);
      const attempt = await runQaExecutorSession({
        adapter,
        taskId: `task-${candidateSha}`,
        worktreePath: process.cwd(),
        context,
        artifactStore: store,
        claims: [CLAIM],
        expectedAssertionsByClaim: {},
        tokenBudget: 1000,
        runtimeBudgetMs: 5000,
        eventSink: () => {},
      });
      // Mirrors the exercise CompletionContext construction in run-phase.ts exactly.
      const expectedByClaim = new Map([[CLAIM_ID, [{ claimId: CLAIM_ID, observes: 'Revealed Text', kind: 'value-match' as const }]]]);
      const coverage = evaluateBehavioralClaimCoverage({
        behavioralClaimIds: [CLAIM_ID],
        assertions: attempt.assertions,
        claimHasExpectedAssertion: (id) => (expectedByClaim.get(id)?.length ?? 0) > 0,
        assertionCoversClaim: (id, a) => {
          const hay = `${a.name} ${a.detail ?? ''}`.toLowerCase();
          return (expectedByClaim.get(id) ?? []).some((e) => hay.includes(e.observes.toLowerCase()));
        },
      });
      const exercise = {
        everyRequiredScenarioHasResult: true,
        everyBehavioralClaimCovered: coverage.everyBehavioralClaimCovered,
        behavioralClaimsMissingStrongAssertion: coverage.missing,
        structuredAssertionsPass: attempt.assertions.every((a) => a.passed),
        requiredRecordingExists: attempt.artifacts.length > 0,
        browserScenariosHaveTraces: attempt.artifacts.some((a) => a.kind === 'browser-trace'),
        evidenceTiedToCandidateSha: attempt.evidence.candidateSha === candidateSha,
        policyBlockingErrorsPresent: attempt.policyBlockingErrorsPresent,
      };
      const decision = evaluatePhaseCompletion({ phase: 'exercise' } as never, { exercise } as never);
      return { attempt, decision };
    }

    it('BLOCKS when the agent honestly reports the behavior did not happen', async () => {
      // The click did nothing on the broken page, so the inspect observes empty text and the
      // agent's own submitted assertion fails — same real chromium, no code-side script.
      const { attempt, decision } = await driveAndGate('/broken', '');
      expect(attempt.assertions.some((a) => a.name === 'join-reveals-panel' && a.passed === false)).toBe(true);
      expect(decision.complete).toBe(false);
    }, 30_000);

    it('CLEARS when the agent observed the real state transition and reported it accurately', async () => {
      const { attempt, decision } = await driveAndGate('/', 'Revealed Text');
      expect(attempt.policyBlockingErrorsPresent).toBe(false);
      expect(decision.complete).toBe(true);
    }, 30_000);
  });
});

describe('buildQaExecutorInstruction', () => {
  it('renders each claim, its expected observations, and the evidence_write contract', () => {
    const instruction = buildQaExecutorInstruction({
      claims: [CLAIM],
      expectedAssertionsByClaim: { [CLAIM_ID]: [{ claimId: CLAIM_ID, observes: 'the panel appears', kind: 'state-transition' }] },
      startCommandHint: { command: 'npm run dev', baseUrl: 'http://localhost:5173' },
    });
    expect(instruction).toContain(CLAIM.description);
    expect(instruction).toContain('the panel appears');
    expect(instruction).toContain('npm run dev');
    expect(instruction).toContain('evidence_write EXACTLY ONCE');
  });

  it('tells the agent it must find its own way when no start command hint exists', () => {
    const instruction = buildQaExecutorInstruction({ claims: [CLAIM], expectedAssertionsByClaim: {} });
    expect(instruction).toContain('find your own way');
  });
});
