import type { RunCondition, TaskPhase } from './lifecycle.js';

/**
 * The single canonical mapping from the workflow's two orthogonal fields (condition + phase) to one
 * human-facing status. Lives in the domain so the daemon's task-summary projection, the task list,
 * the board, and the task header all derive status IDENTICALLY — the walkthrough found the list and
 * detail disagreeing, and one shared derivation is how that stays fixed. The web layer maps
 * `DerivedTaskStatus` onto Badge variants; it must NOT re-derive the status itself.
 */
export type DerivedTaskStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'awaiting-human'
  | 'awaiting-external'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export function deriveTaskStatus(condition: RunCondition, phase: TaskPhase): DerivedTaskStatus {
  switch (condition) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    case 'awaiting-human':
      return 'awaiting-human';
    case 'awaiting-external':
      return 'awaiting-external';
    case 'running':
    default:
      if (phase === 'specify') return 'queued';
      if (phase === 'plan') return 'planning';
      return 'running';
  }
}

/** Display label for a derived status. Shared so list/board/header read the same words. */
export const DERIVED_STATUS_LABEL: Record<DerivedTaskStatus, string> = {
  queued: 'Queued',
  planning: 'Planning',
  running: 'Running',
  'awaiting-human': 'Awaiting Human',
  'awaiting-external': 'Awaiting External',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Statuses that mean "a human needs to look at this" — the board/overview "needs attention" set. */
export const ATTENTION_STATUSES: ReadonlySet<DerivedTaskStatus> = new Set<DerivedTaskStatus>([
  'awaiting-human',
  'blocked',
  'failed',
]);
