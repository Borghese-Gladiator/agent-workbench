import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: ReactNode;
  /** Optional eyebrow/breadcrumb line above the title (e.g. "Repository"). */
  eyebrow?: ReactNode;
  /** When set, renders a back link on the left of the header. */
  back?: { to: string; label: string };
  /** Right-aligned action slot (buttons, filters). */
  actions?: ReactNode;
  className?: string;
}

/**
 * In-page top bar: contextual navigation (back link / breadcrumb eyebrow), the page
 * title, and a right-aligned actions slot. Root-section switching lives in the left
 * sidebar; this bar handles navigation within a related set of pages (e.g. a detail
 * page back to its list).
 */
export function PageHeader({ title, eyebrow, back, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('mb-6 flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        {back ? (
          <Link
            to={back.to}
            className="mb-1.5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {back.label}
          </Link>
        ) : eyebrow ? (
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{title}</h1>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
