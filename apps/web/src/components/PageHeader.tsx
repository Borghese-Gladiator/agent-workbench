import type { ReactNode } from 'react';

/** Page title with an optional right-aligned action slot (e.g. a primary Button). */
export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <header className="page__header">
      <h1>{title}</h1>
      {action}
    </header>
  );
}
