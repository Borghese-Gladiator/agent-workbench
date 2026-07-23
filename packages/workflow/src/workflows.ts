/**
 * Temporal workflow bundle entrypoint — the single module the worker's `workflowsPath` points at,
 * re-exporting every registered workflow (spec §9/§15: TaskWorkflow + RepositoryDiscoveryWorkflow).
 * Temporal bundles one workflows file per worker, so both must be reachable from here.
 */
export { TaskWorkflow } from './task-workflow.js';
export { RepositoryDiscoveryWorkflow } from './discovery-workflow.js';
