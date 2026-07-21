import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import type { QaEvidenceContext } from '@awb/qa';
import { runBrowserQaViaServer } from './browser-qa-support.js';

// A one-liner static server the "dev server" command starts, so we exercise the real
// start -> wait-for-url -> runBrowserQa -> teardown path without a full app.
const SERVE_SCRIPT =
  `require('http').createServer((_,res)=>{res.end('<!doctype html><h1 id=x>ok</h1>')}).listen(${'${PORT}'})`;

const context: QaEvidenceContext = {
  taskId: 'task-1',
  runId: 'run-1',
  phaseAttemptId: 'task-1-exercise-1',
  repositorySnapshotId: 'repo-1-snapshot',
  contractVersion: 1,
  planVersion: 1,
  candidateSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  policyVersion: 'v1',
  claimIds: [],
};

describe('runBrowserQaViaServer (Fix 5: real browser QA)', () => {
  let artifactsDir: string;
  let store: ArtifactStore;
  const port = 5321;

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), 'awb-bqa-'));
    store = new ArtifactStore(artifactsDir, new InMemoryArtifactMetadataStore());
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('starts the server, runs real browser QA, and produces a video + trace artifact', async () => {
    const result = await runBrowserQaViaServer({
      startCommand: `node -e "${SERVE_SCRIPT.replace('${PORT}', String(port))}"`,
      worktreePath: artifactsDir,
      baseUrl: `http://127.0.0.1:${port}`,
      scenario: {
        baseUrl: `http://127.0.0.1:${port}`,
        steps: [{ kind: 'navigate', url: '/' }, { kind: 'waitForSelector', selector: '#x' }],
      },
      context,
      artifactStore: store,
      readinessTimeoutMs: 15_000,
    });

    const kinds = result.artifacts.map((a) => a.kind);
    expect(kinds).toContain('qa-video');
    expect(kinds).toContain('browser-trace');
    expect(result.assertions.some((a) => a.passed)).toBe(true);
  }, 60_000);

  it('throws when the dev server never becomes ready', async () => {
    await expect(
      runBrowserQaViaServer({
        startCommand: 'node -e "setTimeout(()=>{}, 60000)"',
        worktreePath: artifactsDir,
        baseUrl: 'http://127.0.0.1:5322',
        scenario: { baseUrl: 'http://127.0.0.1:5322', steps: [] },
        context,
        artifactStore: store,
        readinessTimeoutMs: 2_000,
      }),
    ).rejects.toThrow(/did not become ready/);
  }, 20_000);
});
