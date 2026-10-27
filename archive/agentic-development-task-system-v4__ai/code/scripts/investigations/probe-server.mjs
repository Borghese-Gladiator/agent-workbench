#!/usr/bin/env node
// Standalone server for the cross-process repro. Blocks its OWN event loop in a
// sync section on /gate, exactly like the daemon's spawnSync in validation_demo.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 4795);
const BLOCK_MS = Number(process.env.BLOCK ?? 3000);
const KA = Number(process.env.KA ?? 5000);

function blockEventLoop(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

const server = http.createServer((req, res) => {
  if (req.url === '/gate') {
    blockEventLoop(BLOCK_MS); // models spawnSync(validation command)
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.end(JSON.stringify({ task: { stage: 'validation_demo', status: 'running' } }));
});
server.keepAliveTimeout = KA;
server.headersTimeout = KA + 5000;
server.on('clientError', (err, sock) => {
  process.stderr.write(`[server] clientError ${err.code}\n`);
  if (!sock.destroyed) sock.destroy();
});
server.listen(PORT, '127.0.0.1', () => process.stderr.write(`[server] up on ${PORT}\n`));
