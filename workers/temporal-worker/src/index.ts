import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as activities from './activities/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TASK_QUEUE = 'awb-task-queue';

export async function startWorker(): Promise<Worker> {
  const worker = await Worker.create({
    taskQueue: TASK_QUEUE,
    workflowsPath: join(__dirname, '..', 'node_modules', '@awb', 'workflow', 'dist', 'task-workflow.js'),
    activities,
  });
  await worker.run();
  return worker;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
