export type StatusTone = 'neutral' | 'progress' | 'attention' | 'success' | 'danger';

export interface TaskStatus {
  label: string;
  tone: StatusTone;
  icon: string;
}

/**
 * Maps the two backend lifecycle fields (condition + phase) onto a single human-facing status.
 * `condition` is authoritative for terminal/waiting states; while `running`, the `phase` refines
 * the label (specify → Queued, plan → Planning, otherwise Running). Tone drives visual treatment,
 * icon accompanies it so status is never communicated by color alone.
 */
export function deriveTaskStatus(condition: string, phase: string): TaskStatus {
  switch (condition) {
    case 'completed':
      return { label: 'Completed', tone: 'success', icon: '✓' };
    case 'failed':
      return { label: 'Failed', tone: 'danger', icon: '✕' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', icon: '⊘' };
    case 'blocked':
      return { label: 'Blocked', tone: 'danger', icon: '‼' };
    case 'awaiting-human':
    case 'awaiting-external':
      return { label: 'Waiting for input', tone: 'attention', icon: '⏳' };
    case 'running':
    default:
      if (phase === 'specify') return { label: 'Queued', tone: 'neutral', icon: '•' };
      if (phase === 'plan') return { label: 'Planning', tone: 'progress', icon: '◐' };
      return { label: 'Running', tone: 'progress', icon: '▶' };
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
