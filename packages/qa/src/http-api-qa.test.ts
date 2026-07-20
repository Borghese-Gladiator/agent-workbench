import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import { runHttpApiQa } from './http-api-qa.js';
import { makeQaEvidenceContext } from './test-helpers.js';

describe('runHttpApiQa', () => {
  let root: string;
  let store: ArtifactStore;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'ok' }));
        return;
      }
      if (req.url === '/echo' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        req.on('end', () => {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: body }));
        });
        return;
      }
      if (req.url === '/secure' && req.method === 'GET') {
        res.writeHead(200, { 'Set-Cookie': 'session=super-secret-token' });
        res.end('secure');
        return;
      }
      res.writeHead(404);
      res.end('not found');
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
    root = await mkdtemp(join(tmpdir(), 'awb-qa-http-'));
    store = new ArtifactStore(root, new InMemoryArtifactMetadataStore());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('makes real HTTP requests and passes when expectations match real responses', async () => {
    const result = await runHttpApiQa(
      {
        baseUrl,
        requests: [
          {
            method: 'GET',
            path: '/ok',
            expectations: [
              { kind: 'status', equals: 200 },
              { kind: 'bodyContains', text: 'ok' },
            ],
          },
          {
            method: 'POST',
            path: '/echo',
            body: 'payload-data',
            expectations: [
              { kind: 'status', equals: 201 },
              { kind: 'bodyContains', text: 'payload-data' },
            ],
          },
        ],
      },
      makeQaEvidenceContext(),
      store,
    );

    expect(result.assertions.every((a) => a.passed)).toBe(true);
    expect(result.evidence.status).toBe('passed');
    expect(result.artifacts).toHaveLength(1);
  });

  it('fails when a real response does not match expectations', async () => {
    const result = await runHttpApiQa(
      {
        baseUrl,
        requests: [
          {
            method: 'GET',
            path: '/ok',
            expectations: [{ kind: 'status', equals: 404 }],
          },
        ],
      },
      makeQaEvidenceContext(),
      store,
    );

    expect(result.assertions[0]?.passed).toBe(false);
    expect(result.evidence.status).toBe('failed');
  });

  it('redacts cookie/auth header values in the stored evidence log', async () => {
    const result = await runHttpApiQa(
      {
        baseUrl,
        requests: [
          {
            method: 'GET',
            path: '/secure',
            headers: { Authorization: 'Bearer top-secret-value' },
            expectations: [{ kind: 'status', equals: 200 }],
          },
        ],
      },
      makeQaEvidenceContext(),
      store,
    );

    expect(result.evidence.status).toBe('passed');
    const artifact = store.get(result.artifacts[0]!.id);
    expect(artifact).toBeDefined();
    const { readFile } = await import('node:fs/promises');
    const contents = await readFile(artifact!.path, 'utf8');
    expect(contents).not.toContain('top-secret-value');
    expect(contents).not.toContain('super-secret-token');
    expect(contents).toContain('[redacted]');
  });
});
