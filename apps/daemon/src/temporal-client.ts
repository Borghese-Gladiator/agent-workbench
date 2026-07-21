import { Connection, Client } from '@temporalio/client';

let cachedClient: Client | undefined;

/** Lazily connects to the local Temporal server. Not cached across AWB_DATA_DIR changes since a real daemon process only ever needs one connection for its lifetime. */
export async function getTemporalClient(): Promise<Client> {
  if (cachedClient) return cachedClient;
  const connection = await Connection.connect();
  cachedClient = new Client({ connection });
  return cachedClient;
}

/**
 * Test seam: point the daemon's routes at an already-connected client (e.g. a
 * `TestWorkflowEnvironment`'s client), so route code can be exercised end to end against a real
 * workflow without a separately running Temporal server. Pass `undefined` to reset.
 */
export function setTemporalClientForTesting(client: Client | undefined): void {
  cachedClient = client;
}

export function workflowIdFor(repositoryId: string, taskId: string): string {
  return `awb/task/${repositoryId}/${taskId}`;
}
