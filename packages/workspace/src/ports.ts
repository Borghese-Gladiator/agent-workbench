import { createServer } from 'node:net';

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('failed to determine bound port'));
        return;
      }
      const { port } = address;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

/**
 * Hands out free TCP ports for services a task's worktree might run (e.g. a dev server),
 * avoiding collisions across concurrently active leases within this process.
 *
 * Availability is checked by briefly binding a TCP socket to port 0 (letting the OS assign a
 * free port) then releasing it immediately. This process additionally tracks every port it has
 * handed out but not yet released, so two concurrent `allocatePort()` calls can never return the
 * same port even if the OS would otherwise reuse one before the caller starts listening on it.
 */
export class PortAllocator {
  private readonly allocated = new Set<number>();

  async allocatePort(): Promise<number> {
    const maxAttempts = 50;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = await findFreePort();
      if (this.allocated.has(port)) continue;
      this.allocated.add(port);
      return port;
    }
    throw new Error('unable to allocate a free port after multiple attempts');
  }

  releasePort(port: number): void {
    this.allocated.delete(port);
  }

  isAllocated(port: number): boolean {
    return this.allocated.has(port);
  }
}
