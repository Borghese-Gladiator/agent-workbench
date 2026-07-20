import { Connection, Client } from '@temporalio/client';

let cachedClient: Client | undefined;

/** Lazily connects to the local Temporal server. Not cached across AWB_DATA_DIR changes since a real daemon process only ever needs one connection for its lifetime. */
export async function getTemporalClient(): Promise<Client> {
  if (cachedClient) return cachedClient;
  const connection = await Connection.connect();
  cachedClient = new Client({ connection });
  return cachedClient;
}

export function workflowIdFor(repositoryId: string, taskId: string): string {
  return `awb/task/${repositoryId}/${taskId}`;
}
