import type { BadgeProps } from '@/components/ui/badge';

export interface TaskStatus {
  label: string;
  variant: NonNullable<BadgeProps['variant']>;
}

/**
 * Maps the daemon's two lifecycle fields (condition + phase) onto a single human-facing status,
 * reusing the Badge variants ported from v4's design system (approval/active/done/abandoned tones).
 */
export function deriveTaskStatus(condition: string, phase: string): TaskStatus {
  switch (condition) {
    case 'completed':
      return { label: 'Completed', variant: 'done' };
    case 'failed':
      return { label: 'Failed', variant: 'abandoned' };
    case 'cancelled':
      return { label: 'Cancelled', variant: 'outline' };
    case 'blocked':
      return { label: 'Blocked', variant: 'abandoned' };
    case 'awaiting-human':
    case 'awaiting-external':
      return { label: 'Waiting for input', variant: 'approval' };
    default:
      if (phase === 'specify') return { label: 'Queued', variant: 'outline' };
      if (phase === 'plan') return { label: 'Planning', variant: 'active' };
      return { label: 'Running', variant: 'active' };
  }
}

export const STATUS_FILTER_OPTIONS = [
  'All',
  'Queued',
  'Planning',
  'Running',
  'Waiting for input',
  'Blocked',
  'Completed',
  'Failed',
  'Cancelled',
] as const;
