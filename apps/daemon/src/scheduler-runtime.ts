import { WorkflowNotFoundError, type WorkflowExecutionStatusName } from '@temporalio/client';
import { TaskWorkflow, getCurrentStateQuery, TASK_PHASE_ORDER } from '@awb/workflow';
import { resolveLayout, resolvePlanningConfig } from '@awb/config';
import type { WorkbenchDatabase } from '@awb/database';
import { getTemporalClient, workflowIdFor } from './temporal-client.js';
import { taskQueueName } from './temporal-worker-constants.js';
import {
  TaskScheduler,
  type StartTaskFn,
  type HasReleasedFn,
  type DescribeWorkflowFn,
  type WorkflowLiveness,
} from './scheduler.js';

/**
 * Real Temporal-backed `startTask`: starts a TaskWorkflow exactly like `POST /api/tasks` does,
 * threading the lazily-resolved stacking base branch.
 */
const realStartTask: StartTaskFn = async (input) => {
  const client = await getTemporalClient();
  // TASK-61 A/B: thread the program-design toggle from config into the deterministic workflow input.
  const disableProgramDesign = resolvePlanningConfig(resolveLayout()).disableProgramDesign;
  await client.workflow.start(TaskWorkflow, {
    taskQueue: taskQueueName(),
    workflowId: workflowIdFor(input.repositoryId, input.taskId),
    args: [
      {
        taskId: input.taskId,
        repositoryId: input.repositoryId,
        prompt: input.prompt,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        ...(disableProgramDesign ? { disableProgramDesign } : {}),
      },
    ],
  });
};

const RELEASE_INDEX = TASK_PHASE_ORDER.indexOf('release');

/**
 * Real `hasReleased`: a parent has released its draft PR once its workflow has reached the
 * `release` phase (where the draft PR is opened and it parks at pr-readiness) or beyond
 * (assimilate). Queries the parent workflow's live state. Returns false if the workflow can't be
 * queried (e.g. not yet started) — the child stays blocked and is retried next tick.
 */
const realHasReleased: HasReleasedFn = async (parentTaskId, repositoryId) => {
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowIdFor(repositoryId, parentTaskId));
    const state = await handle.query(getCurrentStateQuery);
    const phaseIndex = TASK_PHASE_ORDER.indexOf(state.phase);
    return phaseIndex >= RELEASE_INDEX && RELEASE_INDEX >= 0;
  } catch {
    return false;
  }
};

/**
 * Temporal's closed-execution statuses, mapped to what the row should say (TASK-126). A
 * continue-as-new execution is still the same task running, so it maps to `running`. `TERMINATED`
 * and `TIMED_OUT` map to `abandoned`, not `failed`: nothing decided the work was wrong, the run just
 * stopped existing.
 */
const LIVENESS_FOR_STATUS: Readonly<Record<WorkflowExecutionStatusName, WorkflowLiveness>> = {
  RUNNING: 'running',
  CONTINUED_AS_NEW: 'running',
  PAUSED: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TERMINATED: 'absent',
  TIMED_OUT: 'absent',
  UNSPECIFIED: 'unknown',
  UNKNOWN: 'unknown',
};

/**
 * Real `describeWorkflow`: asks Temporal what actually backs a task row.
 *
 * The distinction that matters is between "Temporal says there is no such execution" (absent — the
 * row is a corpse) and "we could not ask" (unknown — leave the row alone). Only
 * `WorkflowNotFoundError` proves the first. Every other error, including Temporal being down, is the
 * second, so an outage can never mass-mark live tasks as abandoned.
 */
const realDescribeWorkflow: DescribeWorkflowFn = async ({ taskId, repositoryId }) => {
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowIdFor(repositoryId, taskId));
    const description = await handle.describe();
    return LIVENESS_FOR_STATUS[description.status.name] ?? 'unknown';
  } catch (err) {
    return err instanceof WorkflowNotFoundError ? 'absent' : 'unknown';
  }
};

/** Builds a production TaskScheduler wired to Temporal. */
export function createTaskScheduler(database: WorkbenchDatabase): TaskScheduler {
  return new TaskScheduler({
    database,
    startTask: realStartTask,
    hasReleased: realHasReleased,
    describeWorkflow: realDescribeWorkflow,
  });
}
