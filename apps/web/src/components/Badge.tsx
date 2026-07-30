import type { StatusTone } from '../lib/task-status.js';

export function StatusBadge({ label, tone, icon }: { label: string; tone: StatusTone; icon: string }) {
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <span className="status-badge__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="status-badge__label">{label}</span>
    </span>
  );
}
