import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as activities from './activities/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TASK_QUEUE = 'awb-task-queue';

export async function startWorker(): Promise<Worker> {
  const worker = await Worker.create({
    taskQueue: TASK_QUEUE,
    // Resolve straight to the real package path, not through the node_modules/@awb symlink —
    // Temporal's webpack-based bundler writes its generated entrypoint's error output relative
    // to cwd rather than consistently following the symlink's resolved path, producing a
    // spurious ENOENT even though the file itself is written correctly. This exact absolute path
    // (repo-root-relative, matching pnpm's monorepo layout) is the same one already proven to
    // work in workers/temporal-worker's own Temporal integration test.
    workflowsPath: join(__dirname, '..', '..', '..', 'packages', 'workflow', 'dist', 'workflows.js'),
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
