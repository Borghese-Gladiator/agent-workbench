import { initTelemetry, shutdownTelemetry } from '@awb/telemetry';
import { startServer } from './server.js';

async function main(): Promise<void> {
  // Boot OpenTelemetry — a no-op unless `awb up` set an OTLP endpoint.
  initTelemetry('awb-daemon');
  const server = await startServer();
  console.log(`Agentic Workbench daemon listening on http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`);

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
  console.error(err);
  process.exitCode = 1;
});
