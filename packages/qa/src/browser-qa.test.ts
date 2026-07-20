import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import { runBrowserQa } from './browser-qa.js';
import { makeQaEvidenceContext } from './test-helpers.js';

const FIXTURE_HTML = `<!doctype html>
<html>
  <head><title>QA Fixture</title></head>
  <body>
    <button id="reveal-button" onclick="document.getElementById('revealed').style.display='block'">Reveal</button>
    <div id="revealed" style="display:none">Revealed Text</div>
    <input id="name-input" type="text" />
    <script>
      console.error("fixture console error for capture test");
    </script>
  </body>
</html>`;

describe('runBrowserQa', () => {
  let root: string;
  let store: ArtifactStore;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url !== '/' && req.url !== '/index.html') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected address info');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'awb-qa-browser-'));
    store = new ArtifactStore(root, new InMemoryArtifactMetadataStore());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    'drives a real chromium instance through a scripted scenario and produces real video/trace evidence',
    async () => {
      const result = await runBrowserQa(
        {
          baseUrl,
          steps: [
            { kind: 'navigate', url: '/' },
            { kind: 'type', selector: '#name-input', text: 'hello world' },
            { kind: 'click', selector: '#reveal-button' },
            { kind: 'waitForSelector', selector: '#revealed' },
            { kind: 'waitForText', text: 'Revealed Text' },
            { kind: 'screenshot', name: 'after-reveal' },
            { kind: 'ariaSnapshot', selector: 'body' },
          ],
        },
        makeQaEvidenceContext(),
        store,
      );

      expect(result.assertions.every((a) => a.passed)).toBe(true);
      expect(result.evidence.status).toBe('passed');

      const videoArtifact = result.artifacts.find((a) => a.kind === 'qa-video');
      const traceArtifact = result.artifacts.find((a) => a.kind === 'browser-trace');
      const screenshotArtifact = result.artifacts.find((a) => a.kind === 'screenshot');
      expect(videoArtifact).toBeDefined();
      expect(traceArtifact).toBeDefined();
      expect(screenshotArtifact).toBeDefined();

      expect(await store.exists(videoArtifact!.id)).toBe(true);
      expect(await store.exists(traceArtifact!.id)).toBe(true);
      expect(videoArtifact!.byteSize).toBeGreaterThan(0);
      expect(traceArtifact!.byteSize).toBeGreaterThan(0);

      expect(result.consoleErrors.some((e) => e.includes('fixture console error'))).toBe(true);
    },
    20_000,
  );

  it(
    'fails with a real assertion failure when waiting on a selector that never appears',
    async () => {
      const result = await runBrowserQa(
        {
          baseUrl,
          steps: [
            { kind: 'navigate', url: '/' },
            { kind: 'waitForSelector', selector: '#does-not-exist', timeoutMs: 1_000 },
          ],
        },
        makeQaEvidenceContext(),
        store,
      );

      expect(result.evidence.status).toBe('inconclusive');
      expect(result.assertions.some((a) => !a.passed)).toBe(true);
    },
    15_000,
  );

  it(
    'captures failed network requests for a real 404 response',
    async () => {
      const result = await runBrowserQa(
        {
          baseUrl,
          steps: [
            { kind: 'navigate', url: '/' },
            { kind: 'navigate', url: '/does-not-exist-route-xyz' },
          ],
        },
        makeQaEvidenceContext(),
        store,
      );

      expect(result.assertions.every((a) => a.passed)).toBe(true);
      expect(result.evidence.status).toBe('passed');
      expect(result.failedRequests.some((f) => f.includes('404'))).toBe(true);
    },
    20_000,
  );
});
