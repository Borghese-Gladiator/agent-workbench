import { proxyActivities } from '@temporalio/workflow';

/**
 * Repository discovery as a first-class Temporal workflow (spec §9/§15, TASK-26). Discovery does
 * real filesystem/git I/O, so the work itself lives in the `discoverRepository` Activity; this
 * workflow is the thin durable wrapper that owns retries and gives discovery its own workflow
 * execution (previously it ran as synchronous daemon-route logic — an accepted deviation recorded in
 * ADR 007, now resolved by this workflow). One execution per onboarding/refresh; short-lived.
 */
export interface DiscoveryActivities {
  discoverRepository(input: { repositoryId: string }): Promise<{ snapshotId: string }>;
}

const activities = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    // Discovery touches git + the filesystem; only transient infra failures retry.
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

export interface RepositoryDiscoveryInput {
  repositoryId: string;
}

export interface RepositoryDiscoveryResult {
  repositoryId: string;
  snapshotId: string;
}

export async function RepositoryDiscoveryWorkflow(
  input: RepositoryDiscoveryInput,
): Promise<RepositoryDiscoveryResult> {
  const { snapshotId } = await activities.discoverRepository({ repositoryId: input.repositoryId });
  return { repositoryId: input.repositoryId, snapshotId };
}

export function discoveryWorkflowIdFor(repositoryId: string): string {
  return `awb/discovery/${repositoryId}`;
}
