import type { BadgeProps } from '@/components/ui/badge';

export interface TaskStatus {
  label: string;
  variant: NonNullable<BadgeProps['variant']>;
}

/**
 * The daemon is the source of truth for derived status (domain deriveTaskStatus, surfaced as
 * `derivedStatus` on the task summary). The browser never re-derives it from scratch as a rule — it
 * maps the canonical status string to presentation (Badge variant + label). `deriveTaskStatus` below
 * is a local fallback for the one response that still only carries condition + phase (live workflow
 * state on the detail page); it mirrors the domain function exactly.
 */
const PRESENTATION: Record<string, TaskStatus> = {
  queued: { label: 'Queued', variant: 'outline' },
  planning: { label: 'Planning', variant: 'active' },
  running: { label: 'Running', variant: 'active' },
  'awaiting-human': { label: 'Awaiting Human', variant: 'approval' },
  'awaiting-external': { label: 'Awaiting External', variant: 'approval' },
  blocked: { label: 'Blocked', variant: 'abandoned' },
  completed: { label: 'Completed', variant: 'done' },
  failed: { label: 'Failed', variant: 'abandoned' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
};

/** Presentation for a canonical derived status (preferred: pass the daemon's `derivedStatus`). */
export function statusPresentation(status: string): TaskStatus {
  return PRESENTATION[status] ?? { label: status, variant: 'outline' };
}

/** Mirror of the domain deriveTaskStatus — for callers that only have condition + phase. */
export function deriveDerivedStatus(condition: string, phase: string): string {
  switch (condition) {
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'blocked':
    case 'awaiting-human':
    case 'awaiting-external':
      return condition;
    default:
      if (phase === 'specify') return 'queued';
      if (phase === 'plan') return 'planning';
      return 'running';
  }
}

/** Condition + phase → presentation, for the live-workflow-state case. */
export function deriveTaskStatus(condition: string, phase: string): TaskStatus {
  return statusPresentation(deriveDerivedStatus(condition, phase));
}

export const STATUS_FILTER_OPTIONS = [
  'All',
  'Queued',
  'Planning',
  'Running',
  'Awaiting Human',
  'Blocked',
  'Completed',
  'Failed',
  'Cancelled',
] as const;
