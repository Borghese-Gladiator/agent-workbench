import type { BadgeProps } from '@/components/ui/badge';
import {
  deriveTaskStatus as deriveDomainStatus,
  DERIVED_STATUS_LABEL,
  ATTENTION_STATUSES,
  type DerivedTaskStatus,
} from '@awb/domain';

export type BadgeVariant = NonNullable<BadgeProps['variant']>;

/**
 * The daemon is the single source of truth for derived status: `deriveTaskStatus` lives in
 * `@awb/domain` and the projection surfaces it as `derivedStatus`. This module re-exports that one
 * canonical derivation (so a live-workflow response carrying only condition + phase can be mapped
 * IDENTICALLY) and keeps ONLY the presentation concern the browser owns — the Badge-variant + label
 * per canonical status. It must never re-derive status with its own rules.
 */
export { deriveDomainStatus as deriveTaskStatus, DERIVED_STATUS_LABEL, ATTENTION_STATUSES };
export type { DerivedTaskStatus };

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

/** Web-only mapping from a canonical derived status to a display label + Badge variant. */
export function statusPresentation(status: string): StatusPresentation {
  const known = status as DerivedTaskStatus;
  const label = DERIVED_STATUS_LABEL[known];
  if (label === undefined) return { label: status, badgeVariant: 'outline' };
  return { label, badgeVariant: BADGE_VARIANT[known] };
}

/** Presentation for the one response that still only carries condition + phase (live workflow state). */
export function presentationFromLifecycle(condition: string, phase: string): StatusPresentation {
  return statusPresentation(deriveDomainStatus(condition as never, phase as never));
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
