import { createDaemonClient } from '../daemon-client.js';

/**
 * The `discoverRepository` Activity behind `RepositoryDiscoveryWorkflow`.
 * Discovery writes snapshot rows, so — like all run-state writes — it goes through the daemon (the
 * single application writer): the activity calls the daemon's refresh endpoint, which runs
 * the real `refreshRepositorySnapshot` and returns the new snapshot id. Keeping the write on the
 * daemon side means the worker never opens a second writer handle even for discovery.
 */
export async function discoverRepository(input: { repositoryId: string }): Promise<{ snapshotId: string }> {
  return createDaemonClient().refreshRepository(input.repositoryId);
}
