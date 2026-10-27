// End-to-end proof: real chromium QA (@awb/qa runBrowserQa) wired to the real completion
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
import {
  runBrowserQa,
  evaluateBehavioralClaimCoverage,
  scenarioStrength,
  type QaEvidenceContext,
} from '@awb/qa';
import { classifyExerciseBlock, evaluatePhaseCompletion } from '@awb/workflow';

// BROKEN: clicking "Join" does NOT perform the behavioral state transition — the room panel stays
// empty (the button's handler is broken/absent). QA validates the frontend's observable
// behaviour, so the expected value assertion fails and the behavioral claim is uncovered.
const BROKEN_HTML = `<!doctype html><html><head><title>broken</title></head><body>
  <button id="join">Join</button>
  <div id="revealed"></div>
</body></html>`;

// CORRECT: the click performs the state transition — the panel is populated with the expected text.
const CORRECT_HTML = `<!doctype html><html><head><title>correct</title></head><body>
  <button id="join" onclick="document.getElementById('revealed').textContent='Revealed Text'">Join</button>
  <div id="revealed"></div>
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
      scenarioStrengthSufficient: scenarioStrength(qaResult.assertions) === 'strong',
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
        steps: [
          { kind: 'navigate', url: path },
          { kind: 'click', selector: '#join' },
          // The behavioral claim's target: after clicking Join, the room panel shows this text.
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

  it('BLOCKS a broken feature (the behavioral state transition never happens)', async () => {
    const { qa, ctx, decision } = await driveQaAndGate('/broken');
    console.log('[BROKEN] qaStatus=%s structuredAssertionsPass=%s claimCovered=%s gate.complete=%s missing=%o',
      qa.evidence.status, ctx.exercise.structuredAssertionsPass,
      ctx.exercise.everyBehavioralClaimCovered, decision.complete, decision.missing);
    // The click did nothing, so the expected-value assertion failed and no passing strong
    // assertion covers the behavioral claim — the gate refuses to clear.
    expect(ctx.exercise.everyBehavioralClaimCovered).toBe(false);
    expect(decision.complete).toBe(false);
    // TASK-75: the expected-value assertion actually RAN and FAILED (structuredAssertionsPass is
    // false) — a real behavioral defect — so this is code-fixable and routes repair→implement,
    // not the human qa-inconclusive gate reserved for missing/insufficient evidence.
    expect(ctx.exercise.structuredAssertionsPass).toBe(false);
    expect(classifyExerciseBlock(ctx.exercise)).toBe('code-fixable');
  }, 30_000);

  it('CLEARS the same feature when it actually works', async () => {
    const { qa, ctx, decision } = await driveQaAndGate('/correct');
    console.log('[CORRECT] qaStatus=%s structuredAssertionsPass=%s claimCovered=%s gate.complete=%s',
      qa.evidence.status, ctx.exercise.structuredAssertionsPass,
      ctx.exercise.everyBehavioralClaimCovered, decision.complete);
    expect(qa.policyBlockingErrorsPresent).toBe(false);
    expect(ctx.exercise.everyBehavioralClaimCovered).toBe(true);
    expect(decision.complete).toBe(true);
  }, 30_000);
});
