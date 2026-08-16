import { TaskWorkflow, getCurrentStateQuery, TASK_PHASE_ORDER } from '@awb/workflow';
import type { WorkbenchDatabase } from '@awb/database';
import { getTemporalClient, workflowIdFor } from './temporal-client.js';
import { taskQueueName } from './temporal-worker-constants.js';
import { TaskScheduler, type StartTaskFn, type HasReleasedFn } from './scheduler.js';

/**
 * Real Temporal-backed `startTask`: starts a TaskWorkflow exactly like `POST /api/tasks` does,
 * threading the lazily-resolved stacking base branch.
 */
const realStartTask: StartTaskFn = async (input) => {
  const client = await getTemporalClient();
  await client.workflow.start(TaskWorkflow, {
    taskQueue: taskQueueName(),
    workflowId: workflowIdFor(input.repositoryId, input.taskId),
    args: [
      {
        taskId: input.taskId,
        repositoryId: input.repositoryId,
        prompt: input.prompt,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
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

/** Builds a production TaskScheduler wired to Temporal. */
export function createTaskScheduler(database: WorkbenchDatabase): TaskScheduler {
  return new TaskScheduler({ database, startTask: realStartTask, hasReleased: realHasReleased });
}
