import { useState } from 'react';

/** Compact, dismissible informational notice with an info icon and an optional learn-more link. */
export function InfoNotice({
  children,
  learnMoreHref,
}: {
  children: React.ReactNode;
  learnMoreHref?: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="info-notice" role="note">
      <span className="info-notice__icon" aria-hidden="true">
        ⓘ
      </span>
      <p className="info-notice__text">{children}</p>
      {learnMoreHref && (
        <a className="info-notice__link" href={learnMoreHref} target="_blank" rel="noreferrer">
          Learn more
        </a>
      )}
      <button
        type="button"
        className="icon-button info-notice__dismiss"
        aria-label="Dismiss notice"
        onClick={() => setDismissed(true)}
      >
        ✕
      </button>
    </div>
  );
}
