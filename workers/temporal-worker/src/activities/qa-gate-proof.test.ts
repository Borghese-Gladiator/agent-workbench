// TASK-42 end-to-end proof: real chromium QA (@awb/qa runBrowserQa) wired to the real completion
// gate (@awb/workflow evaluatePhaseCompletion) exactly the way the exercise phase does it in
// run-phase.ts — no mocks. Demonstrates that the gate BLOCKS a broken feature and CLEARS a correct
// one, so "run success" now means "working artifact", not "the page loaded".
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import { runBrowserQa, evaluateBehavioralClaimCoverage, type QaEvidenceContext } from '@awb/qa';
import { evaluatePhaseCompletion } from '@awb/workflow';

// BROKEN: "Join" opens TWO sockets per click (leaked-connection bug) and the panel never appears.
const BROKEN_HTML = `<!doctype html><html><head><title>broken</title></head><body>
  <button id="join" onclick="new WebSocket('ws://127.0.0.1:1/a'); new WebSocket('ws://127.0.0.1:1/b')">Join</button>
  <div id="revealed" style="display:none">Revealed Text</div>
</body></html>`;

// CORRECT: the click reveals the panel with the expected text — no leaked sockets, no failed
// requests, no console errors. (The broken variant's bug is the duplicate socket; the correct
// feature simply does the state transition the behavioral claim demands.)
const CORRECT_HTML = `<!doctype html><html><head><title>correct</title></head><body>
  <button id="join" onclick="document.getElementById('revealed').style.display='block'">Join</button>
  <div id="revealed" style="display:none">Revealed Text</div>
</body></html>`;

const CLAIM_ID = 'claim-behavior-1';
const EXPECTED = [{ claimId: CLAIM_ID, observes: 'Revealed Text', kind: 'value-match' as const }];

function makeContext(candidateSha: string): QaEvidenceContext {
  return {
    taskId: randomUUID(),
    runId: 'run',
    phaseAttemptId: 'exercise-1',
    repositorySnapshotId: 'snap',
    contractVersion: 1,
    planVersion: 1,
    candidateSha,
    policyVersion: 'v1',
    claimIds: [CLAIM_ID],
  };
}

// Mirrors the exercise CompletionContext construction in run-phase.ts exactly.
function buildExerciseContext(qaResult: Awaited<ReturnType<typeof runBrowserQa>>, candidateSha: string) {
  const policyBlockingErrorsPresent =
    'policyBlockingErrorsPresent' in qaResult ? qaResult.policyBlockingErrorsPresent : false;
  const expectedByClaim = new Map([[CLAIM_ID, EXPECTED]]);
  const coverage = evaluateBehavioralClaimCoverage({
    behavioralClaimIds: [CLAIM_ID],
    assertions: qaResult.assertions,
    claimHasExpectedAssertion: (id) => (expectedByClaim.get(id)?.length ?? 0) > 0,
    assertionCoversClaim: (id, a) => {
      const hay = `${a.name} ${a.detail ?? ''}`.toLowerCase();
      return (expectedByClaim.get(id) ?? []).some((e) => hay.includes(e.observes.toLowerCase()));
    },
  });
  return {
    exercise: {
      everyRequiredScenarioHasResult: true,
      everyBehavioralClaimCovered: coverage.everyBehavioralClaimCovered,
      behavioralClaimsMissingStrongAssertion: coverage.missing,
      structuredAssertionsPass: qaResult.assertions.every((a) => a.passed),
      requiredRecordingExists: qaResult.artifacts.length > 0,
      browserScenariosHaveTraces: qaResult.artifacts.some((a) => a.kind === 'browser-trace'),
      evidenceTiedToCandidateSha: qaResult.evidence.candidateSha === candidateSha,
      policyBlockingErrorsPresent,
    },
  } as const;
}

describe('TASK-42 proof: real QA → real completion gate', () => {
  let server: Server;
  let baseUrl: string;
  let root: string;
  let store: ArtifactStore;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = req.url?.startsWith('/broken') ? BROKEN_HTML : CORRECT_HTML;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'awb-qa-gate-proof-'));
    store = new ArtifactStore(root, new InMemoryArtifactMetadataStore());
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function driveQaAndGate(path: string) {
    const candidateSha = `sha-${path.replace(/\W/g, '')}`;
    const qa = await runBrowserQa(
      {
        baseUrl,
        maxSocketsPerAction: 1,
        steps: [
          { kind: 'navigate', url: path },
          { kind: 'click', selector: '#join' },
          { kind: 'expectText', selector: '#revealed', equals: 'Revealed Text' },
        ],
      },
      makeContext(candidateSha),
      store,
    );
    const ctx = buildExerciseContext(qa, candidateSha);
    const decision = evaluatePhaseCompletion({ phase: 'exercise' } as never, ctx as never);
    return { qa, ctx, decision };
  }

  it('BLOCKS a broken feature (leaked sockets + missing state transition)', async () => {
    const { qa, ctx, decision } = await driveQaAndGate('/broken');
    console.log('[BROKEN] qaStatus=%s socketAnomalies=%o policyBlocking=%s claimCovered=%s gate.complete=%s missing=%o',
      qa.evidence.status, qa.socketAnomalies, qa.policyBlockingErrorsPresent,
      ctx.exercise.everyBehavioralClaimCovered, decision.complete, decision.missing);
    // The click opened 2 sockets (leak) and the expected text never appeared.
    expect(qa.socketAnomalies.length).toBeGreaterThan(0);
    expect(qa.policyBlockingErrorsPresent).toBe(true);
    expect(decision.complete).toBe(false);
  }, 30_000);

  it('CLEARS the same feature when it actually works', async () => {
    const { qa, ctx, decision } = await driveQaAndGate('/correct');
    console.log('[CORRECT] qaStatus=%s socketAnomalies=%o policyBlocking=%s claimCovered=%s gate.complete=%s',
      qa.evidence.status, qa.socketAnomalies, qa.policyBlockingErrorsPresent,
      ctx.exercise.everyBehavioralClaimCovered, decision.complete);
    expect(qa.socketAnomalies).toEqual([]);
    expect(qa.policyBlockingErrorsPresent).toBe(false);
    expect(decision.complete).toBe(true);
  }, 30_000);
});
