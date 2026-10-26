import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Panel — the framed, sectioned container the redesign is built around. A panel
 * is a bordered `bg-card` frame; `PanelHeader` puts an uppercase, tracked label
 * (with an optional right-side action/eyebrow) at the top; `PanelBody` is the
 * padded content slot; `StatTile` is a nested mini-panel (label over a large
 * mono/tabular value) for the metric grids.
 */
const Panel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('overflow-hidden rounded-lg border bg-card', className)}
      {...props}
    />
  ),
);
Panel.displayName = 'Panel';

/**
 * Section header: uppercase tracked title on the left, optional `action` slot on
 * the right (filter control, eyebrow count, status pill). The title renders as a
 * real heading so it's reachable as an accessible name.
 */
const PanelHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { title: React.ReactNode; action?: React.ReactNode }
>(({ className, title, action, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex items-center justify-between gap-3 border-b px-4 py-3', className)}
    {...props}
  >
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {title}
    </h3>
    {action}
  </div>
));
PanelHeader.displayName = 'PanelHeader';

const PanelBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-4', className)} {...props} />,
);
PanelBody.displayName = 'PanelBody';

/**
 * Nested metric tile (the stat boxes in the screenshots): small uppercase label
 * over a large mono/tabular value, on the surface-2 step. `tone` colors the
 * value for emphasis (e.g. accent for the headline, danger for a regression).
 */
const TILE_TONES = {
  default: 'text-foreground',
  accent: 'text-primary',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
} as const;

function StatTile({
  label,
  value,
  tone = 'default',
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: keyof typeof TILE_TONES;
  className?: string;
}) {
  return (
    <div className={cn('rounded-md border bg-surface-2 px-3.5 py-3', className)}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn('mt-1.5 font-mono text-xl tabular-nums', TILE_TONES[tone])}>{value}</div>
    </div>
  );
}

export { Panel, PanelBody, PanelHeader, StatTile };
