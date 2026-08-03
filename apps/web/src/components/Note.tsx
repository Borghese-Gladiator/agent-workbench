import type { ReactNode } from 'react';

/**
 * A neutral informational box (the former `.note` paragraph). For a dismissible, icon-led banner
 * with a learn-more link, use InfoNotice instead; Note is the plain always-present explainer used
 * on placeholder pages and panels.
 */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="note" role="note">
      {children}
    </p>
  );
}
