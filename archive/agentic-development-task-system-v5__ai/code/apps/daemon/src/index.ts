import { initTelemetry, shutdownTelemetry, createLogger } from '@awb/telemetry';
import { resolveRuntimeConfig } from '@awb/config';
import { startServer } from './server.js';

const log = createLogger('awb-daemon');

async function main(): Promise<void> {
  // Boot OpenTelemetry — a no-op unless `awb up` set an OTLP endpoint.
  initTelemetry('awb-daemon');
  const server = await startServer(resolveRuntimeConfig().daemonPort);
  const port = (server.app.server.address() as { port: number }).port;
  log.info('daemon listening', { url: `http://127.0.0.1:${port}`, port });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    // Guard against a double signal (e.g. Ctrl+C pressed twice) trying to close the Fastify
    // server / database handle concurrently, which would otherwise throw on the second call.
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    await shutdownTelemetry();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  log.error('daemon boot failed', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exitCode = 1;
});
