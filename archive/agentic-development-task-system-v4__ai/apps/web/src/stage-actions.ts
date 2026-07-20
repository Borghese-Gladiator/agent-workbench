/**
 * Maps a task's current stage to the lifecycle actions a human can take from
 * the dashboard. This mirrors the daemon's allowed transitions; the daemon is
 * still the authority (it will 409 an illegal action), but having the menu here
 * keeps the UI honest and declarative rather than scattering conditionals in
 * JSX. Each action POSTs to `/api/tasks/:id/<endpoint>`.
 */
import { type BounceTarget, isAutoAdvanceable, type Stage, type TaskStatus } from '@workbench/core';

export interface StageAction {
  endpoint: string;
  label: string;
  /** Explicit bounce target sent as `body.target` (no free-text prompt). */
  bounceTarget?: BounceTarget;
  /** Reject/bounce: a review comment is mandatory so the redo gets guidance. */
  requiresComment?: boolean;
  tone?: 'primary' | 'danger' | 'default';
}

/**
 * The lifecycle actions a human can take from the current stage.
 *
 * Only manual stages return actions: the pre-first-gate stages (intake /
 * task_brief) and the 4 human gates. The non-gate work stages auto-advance —
 * the driver runs them, so the UI shows live progress, not a button.
 */
export function actionsForStage(stage: Stage, status: TaskStatus): StageAction[] {
  if (status === 'abandoned' || status === 'done') return [];
  // Auto-advanceable stages are driver-run; the UI shows the live run panel.
  // The Resume action is the recovery hatch for a parked task (the driving
  // POST died with a daemon restart/crash) — disabled while a run is active,
  // and the daemon 409s a stray double-click.
  if (isAutoAdvanceable(stage)) {
    return [{ endpoint: 'resume', label: 'Resume stage agent', tone: 'primary' }];
  }

  switch (stage) {
    case 'intake':
      return [{ endpoint: 'generate-brief', label: 'Generate Task Brief', tone: 'primary' }];
    case 'task_brief':
      return [{ endpoint: 'generate-brief', label: 'Regenerate Task Brief', tone: 'primary' }];
    case 'human_brief_approval':
      return [
        { endpoint: 'approve-brief', label: 'Approve Brief', tone: 'primary' },
        { endpoint: 'reject-brief', label: 'Reject Brief', tone: 'danger', requiresComment: true },
      ];
    case 'human_plan_approval':
      return [
        { endpoint: 'approve-plan', label: 'Approve Plan', tone: 'primary' },
        { endpoint: 'reject-plan', label: 'Reject Plan', tone: 'danger', requiresComment: true },
      ];
    case 'human_review':
      return [
        { endpoint: 'review/complete', label: 'Complete', tone: 'primary' },
        {
          endpoint: 'review/bounce',
          label: 'Bounce → Implementation',
          bounceTarget: 'implementation',
          requiresComment: true,
        },
        {
          endpoint: 'review/bounce',
          label: 'Bounce → Plan',
          bounceTarget: 'discovery',
          requiresComment: true,
        },
        // Abandoning the task is the global "Cancel task" header action (works
        // from any stage), not a gate-specific button.
      ];
    case 'human_delivery_approval':
      return [
        { endpoint: 'approve-delivery', label: 'Approve Delivery', tone: 'primary' },
        {
          endpoint: 'reject-delivery',
          label: 'Reject Delivery',
          tone: 'danger',
          requiresComment: true,
        },
      ];
    default:
      return [];
  }
}
