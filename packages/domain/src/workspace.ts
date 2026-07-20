import { z } from 'zod';

export const ExecutionProfileSchema = z.enum([
  'native-trusted',
  'repository-defined',
  'container-isolated',
]);
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

export const WorkspaceLeaseStateSchema = z.enum([
  'requested',
  'materializing',
  'ready',
  'active',
  'preserved',
  'removing',
  'removed',
  'failed',
]);
export type WorkspaceLeaseState = z.infer<typeof WorkspaceLeaseStateSchema>;

export const WorkspaceLeaseSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  taskId: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  branchName: z.string(),
  worktreePath: z.string(),
  executionProfile: ExecutionProfileSchema,
  allocatedPorts: z.record(z.string(), z.number().int()),
  state: WorkspaceLeaseStateSchema,
  createdAt: z.string(),
});
export type WorkspaceLease = z.infer<typeof WorkspaceLeaseSchema>;
