import { startServer } from './server.js';

async function main(): Promise<void> {
  const server = await startServer();
  console.log(`Agentic Workbench daemon listening on http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
