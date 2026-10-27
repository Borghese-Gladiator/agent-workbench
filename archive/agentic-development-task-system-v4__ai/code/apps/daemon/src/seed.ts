/**
 * Seed one example project and one example task (left in Intake so a human can
 * walk the whole lifecycle from the dashboard). Idempotent-ish: skips if a
 * project named "Example Web App" already exists.
 */
import { Store } from '@workbench/store';
import { logger } from './logger.js';
import { ARTIFACTS_DIR, DB_PATH } from './paths.js';

const log = logger.child({ component: 'seed' });
const store = new Store({ dbPath: DB_PATH, artifactsDir: ARTIFACTS_DIR });

const existing = store.listProjects().find((p) => p.name === 'Example Web App');
if (existing) {
  log.info('example project already present; nothing to do');
  store.close();
  process.exit(0);
}

const project = store.createProject({
  name: 'Example Web App',
  description: 'A sample project for exercising the workbench lifecycle end to end.',
  // Mock runtime: drives the lifecycle with stub artifacts + a stub worktree, so
  // the placeholder repoPath below never needs to be a real checkout. The UI
  // does not expose the mock runtime; it's for the seed/demo and tests only.
  agentRuntime: 'mock',
  repoPath: '/Users/you/code/example-web-app',
  defaultBranch: 'main',
  deliveryPolicy: 'create_pr',
  testCommand: 'npm test',
  lintCommand: 'npm run lint',
  typecheckCommand: 'npm run typecheck',
  e2eCommand: 'npm run e2e',
  devCommand: 'npm run dev',
});

const task = store.createTask({
  projectId: project.id,
  title: 'Add dark mode toggle to settings',
  rawRequest:
    'Users want a dark mode. Add a toggle in Settings that persists their choice and respects the OS preference by default.',
});

log.info(
  { projectId: project.id, taskId: task.id },
  'created example project and task (in intake)',
);
store.close();
