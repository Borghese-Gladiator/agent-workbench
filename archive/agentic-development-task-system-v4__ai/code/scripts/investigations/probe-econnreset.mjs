#!/usr/bin/env node
/**
 * Cross-process recorder repro. Spawns probe-server.mjs (which blocks its event
 * loop in a sync section on /gate, like the daemon's spawnSync). This client is a
 * SEPARATE process, so its timers run while the server is blocked — exactly like
 * the real Playwright recorder polling the daemon.
 *
 * It fires the blocking /gate, then polls /tasks on a keep-alive socket with a
 * finite client timeout. We observe what the poller sees while the server loop is
 * dead. Tries both http.Agent and fetch/undici.
 *
 * Run: node scripts/probe-client.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4795;
const BLOCK_MS = Number(process.env.BLOCK ?? 3000);
const CLIENT_TIMEOUT = Number(process.env.CT ?? 1000);

const server = spawn('node', [join(HERE, 'probe-server.mjs')], {
  env: { ...process.env, PORT: String(PORT), BLOCK: String(BLOCK_MS) },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sleep(400); // let server boot

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const agentGet = (path) =>
    new Promise((resolve) => {
      const r = http.request(
        { host: '127.0.0.1', port: PORT, path, agent, timeout: CLIENT_TIMEOUT },
        (res) => {
          res.resume();
          res.on('end', () => resolve('ok'));
        },
      );
      r.on('timeout', () => r.destroy(new Error('ETIMEDOUT')));
      r.on('error', (e) => resolve(`ERROR ${e.code ?? e.message}`));
      r.end();
    });

  const fetchGet = async (path) => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
        signal: AbortSignal.timeout(CLIENT_TIMEOUT),
      });
      await res.text();
      return 'ok';
    } catch (e) {
      return `ERROR ${e.cause?.code ?? e.name ?? e.message}`;
    }
  };

  for (const [name, get] of [
    ['http.Agent', agentGet],
    ['fetch/undici', fetchGet],
  ]) {
    console.log(`\n=== ${name}  (block=${BLOCK_MS}ms, clientTimeout=${CLIENT_TIMEOUT}ms) ===`);
    console.log('  prime:', await get('/tasks/x')); // pool a keep-alive socket

    // Fire the blocking gate on a separate fetch (fire-and-forget, like fireGate).
    fetch(`http://127.0.0.1:${PORT}/gate`, { method: 'POST' }).catch(() => {});
    await sleep(50); // let the server enter the block

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await get(`/poll${i}`)); // reuse the pooled socket
      await sleep(300);
    }
    console.log('  polls:', results.join(', '));
    const bad = results.filter((r) => r.startsWith('ERROR'));
    console.log(`  -> errors: ${bad.length}/6 : ${bad.join(', ') || 'none'}`);
    await sleep(BLOCK_MS); // let the loop fully recover before the next client
  }

  server.kill();
  process.exit(0);
}

main();
