import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import { runBrowserQa } from './browser-qa.js';
import { scenarioStrength } from './shared.js';
import { makeQaEvidenceContext } from './test-helpers.js';

const FIXTURE_HTML = `<!doctype html>
<html>
  <head><title>QA Fixture</title></head>
  <body>
    <button id="reveal-button" onclick="document.getElementById('revealed').style.display='block'">Reveal</button>
    <div id="revealed" style="display:none">Revealed Text</div>
    <input id="name-input" type="text" />
  </body>
</html>`;

// A fixture that emits a console error at load, so the console-error capture test can
// assert QA fails on it.
const CONSOLE_ERROR_HTML = `<!doctype html>
<html>
  <head><title>QA Fixture (console error)</title></head>
  <body>
    <p>hi</p>
    <script>console.error("fixture console error for capture test");</script>
  </body>
</html>`;

// A fixture whose "connect" button opens a NEW WebSocket on every click (the socket-leak bug):
// no idempotency guard, so a repeat click opens a duplicate connection. The socket connects back
// to this test's own http server (which completes a real RFC6455 handshake on upgrade) so the
// connection actually opens and closes cleanly instead of hanging on an unreachable port.
const SOCKET_LEAK_HTML = `<!doctype html>
<html>
  <head><title>QA Fixture (socket leak)</title></head>
  <body>
    <button id="connect" onclick="new WebSocket('ws://' + location.host + '/leak')">Connect</button>
  </body>
</html>`;

// A fixture whose "connect" button opens a WebSocket only once, then guards against re-opening —
// the correct, idempotent behaviour.
const SOCKET_IDEMPOTENT_HTML = `<!doctype html>
<html>
  <head><title>QA Fixture (socket idempotent)</title></head>
  <body>
    <button id="connect" onclick="if(!window.__ws){window.__ws=new WebSocket('ws://' + location.host + '/ok');}">Connect</button>
  </body>
</html>`;

// Minimal RFC6455 server handshake so the browser's WebSocket actually opens (and can close
// cleanly) — avoids the hang a connection to a dead port causes during context/video teardown.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptWebSocket(socket: Duplex, key: string): void {
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

describe('runBrowserQa', () => {
  let root: string;
  let store: ArtifactStore;
  let server: Server;
  let baseUrl: string;
  const wsSockets = new Set<Duplex>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/console-error') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(CONSOLE_ERROR_HTML);
        return;
      }
      if (req.url === '/socket-leak') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SOCKET_LEAK_HTML);
        return;
      }
      if (req.url === '/socket-idempotent') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SOCKET_IDEMPOTENT_HTML);
        return;
      }
      if (req.url !== '/' && req.url !== '/index.html') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIXTURE_HTML);
    });
    // Complete a real WebSocket handshake for the socket fixtures so the browser's connection opens
    // and closes cleanly (an un-upgraded/dead socket would hang context teardown).
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (typeof key === 'string') {
        acceptWebSocket(socket, key);
        wsSockets.add(socket);
        socket.on('close', () => wsSockets.delete(socket));
      } else socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected address info');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const socket of wsSockets) socket.destroy();
    wsSockets.clear();
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
            // A genuine post-action state assertion (state-transition) + a value match.
            { kind: 'expectVisible', selector: '#revealed' },
            { kind: 'expectText', selector: '#revealed', equals: 'Revealed Text' },
            { kind: 'screenshot', name: 'after-reveal' },
          ],
        },
        makeQaEvidenceContext(),
        store,
      );

      expect(result.assertions.every((a) => a.passed)).toBe(true);
      expect(result.evidence.status).toBe('passed');
      expect(result.policyBlockingErrorsPresent).toBe(false);
      // The scenario exercises real behaviour, so it is not a weak (all-liveness) scenario.
      expect(scenarioStrength(result.assertions)).toBe('strong');

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
    },
    20_000,
  );

  it(
    'expectVisible with a GROUPED selector passes via .first() when any match is visible, and yields a strong assertion',
    async () => {
      const result = await runBrowserQa(
        {
          baseUrl,
          steps: [
            { kind: 'navigate', url: '/' },
            // A comma-grouped selector — the fixture has a <button> and <input> (no h1/header). This
            // must NOT trip Playwright strict-mode on multiple matches; `.first()` checks "at least
            // one is visible". Mirrors the exercise phase's structural landmark assertion.
            { kind: 'expectVisible', selector: 'h1, header, nav, main, button, input' },
          ],
        },
        makeQaEvidenceContext(),
        store,
      );

      const a = result.assertions.find((x) => x.name.startsWith('expectVisible:'));
      expect(a?.passed).toBe(true);
      expect(scenarioStrength(result.assertions)).toBe('strong');
    },
    15_000,
  );

  it(
    'expectVisible fails (real assertion failure) when NO element in a grouped selector is present',
    async () => {
      const result = await runBrowserQa(
        {
          baseUrl,
          steps: [
            { kind: 'navigate', url: '/' },
            { kind: 'expectVisible', selector: 'h1, header, nav, main, article, [role="banner"]', timeoutMs: 1_000 },
          ],
        },
        makeQaEvidenceContext(),
        store,
      );

      const a = result.assertions.find((x) => x.name.startsWith('expectVisible:'));
      expect(a?.passed).toBe(false);
      expect(result.assertions.some((x) => !x.passed)).toBe(true);
    },
    15_000,
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
    'fails QA on a real 404 response (network error is a blocking signal)',
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

      // A captured 4xx produces a failing assertion and blocks the gate.
      expect(result.failedRequests.some((f) => f.includes('404'))).toBe(true);
      expect(result.policyBlockingErrorsPresent).toBe(true);
      expect(result.evidence.status).toBe('failed');
      expect(result.assertions.some((a) => a.name === 'no-failed-request' && !a.passed)).toBe(true);
    },
    20_000,
  );

  it(
    'fails QA on an unhandled console error',
    async () => {
      const result = await runBrowserQa(
        { baseUrl, steps: [{ kind: 'navigate', url: '/console-error' }] },
        makeQaEvidenceContext(),
        store,
      );

      expect(result.consoleErrors.some((e) => e.includes('fixture console error'))).toBe(true);
      expect(result.policyBlockingErrorsPresent).toBe(true);
      expect(result.evidence.status).toBe('failed');
    },
    20_000,
  );

  it(
    'fails no-duplicate-socket when a repeat click on a socket-opening control opens a second socket',
    async () => {
      const result = await runBrowserQa(
        {
          baseUrl,
          steps: [
            { kind: 'navigate', url: '/socket-leak' },
            { kind: 'expectNoDuplicateSocket', selector: '#connect', settleMs: 300 },
          ],
        },
        makeQaEvidenceContext(),
        store,
      );

      const socketAssertion = result.assertions.find((a) => a.name.startsWith('no-duplicate-socket:'));
      expect(socketAssertion?.passed).toBe(false);
      expect(result.socketOpensByInteraction).toEqual([1]);
      expect(result.evidence.status).toBe('failed');
    },
    // Two clicks + two settle waits + full video/trace teardown, so a larger budget than the
    // single-interaction sibling tests.
    30_000,
  );

  it(
    'passes no-duplicate-socket when the control guards against re-opening the WebSocket',
    async () => {
      const result = await runBrowserQa(
        {
          baseUrl,
          steps: [
            { kind: 'navigate', url: '/socket-idempotent' },
            { kind: 'expectNoDuplicateSocket', selector: '#connect', settleMs: 300 },
          ],
        },
        makeQaEvidenceContext(),
        store,
      );

      const socketAssertion = result.assertions.find((a) => a.name.startsWith('no-duplicate-socket:'));
      expect(socketAssertion?.passed).toBe(true);
      expect(result.socketOpensByInteraction).toEqual([0]);
      // A state-transition assertion — the scenario is strong.
      expect(scenarioStrength(result.assertions)).toBe('strong');
    },
    30_000,
  );
});
