import type { BadgeProps } from '@/components/ui/badge';

export type BadgeVariant = NonNullable<BadgeProps['variant']>;

/**
 * The canonical closed set of derived task statuses. Mirrors `@awb/domain`'s `DerivedTaskStatus`
 * union — the browser cannot import `packages/*` (the "browser never touches fs/git/shell / imports
 * a package module" invariant from AGENTS.md), so this is a hand-kept mirror rather than an import.
 * The daemon is the source of truth: the task_summary projection surfaces `derivedStatus` computed by
 * the domain function; the web only maps that string to presentation and, for the ONE response that
 * still carries just condition + phase (live workflow state), mirrors the derivation exactly.
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

/** Display label per derived status. Mirror of domain `DERIVED_STATUS_LABEL`. */
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

/** Statuses that mean "a human needs to look at this". Mirror of domain `ATTENTION_STATUSES`. */
export const ATTENTION_STATUSES: ReadonlySet<DerivedTaskStatus> = new Set<DerivedTaskStatus>([
  'awaiting-human',
  'blocked',
  'failed',
]);

/**
 * Mirror of the domain `deriveTaskStatus` — used only for the live-workflow-state response that
 * still carries condition + phase instead of a precomputed `derivedStatus`. Kept byte-for-byte in
 * sync with `packages/domain/src/task-status.ts`.
 */
export function deriveTaskStatus(condition: string, phase: string): DerivedTaskStatus {
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
    default:
      if (phase === 'specify') return 'queued';
      if (phase === 'plan') return 'planning';
      return 'running';
  }
}

const BADGE_VARIANT: Record<DerivedTaskStatus, BadgeVariant> = {
  queued: 'outline',
  planning: 'active',
  running: 'active',
  'awaiting-human': 'approval',
  'awaiting-external': 'approval',
  blocked: 'abandoned',
  completed: 'done',
  failed: 'abandoned',
  cancelled: 'outline',
};

export interface StatusPresentation {
  label: string;
  badgeVariant: BadgeVariant;
}

/**
 * Web-only mapping from a canonical derived status to a display label + Badge variant. This is the
 * ONLY status logic the browser owns; everything else defers to the daemon's `derivedStatus`.
 */
export function statusPresentation(status: string): StatusPresentation {
  const known = status as DerivedTaskStatus;
  const label = DERIVED_STATUS_LABEL[known];
  if (label === undefined) return { label: status, badgeVariant: 'outline' };
  return { label, badgeVariant: BADGE_VARIANT[known] };
}

/** Presentation for the live-workflow-state case (condition + phase only). */
export function presentationFromLifecycle(condition: string, phase: string): StatusPresentation {
  return statusPresentation(deriveTaskStatus(condition, phase));
}

export const STATUS_FILTER_OPTIONS = [
  'All',
  'Queued',
  'Planning',
  'Running',
  'Awaiting Human',
  'Awaiting External',
  'Blocked',
  'Completed',
  'Failed',
  'Cancelled',
] as const;
