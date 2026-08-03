import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './Badge.js';

describe('StatusBadge', () => {
  it('renders the label as text and applies the tone class (not color alone)', () => {
    const { container } = render(<StatusBadge label="Running" tone="progress" icon="▶" />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(container.querySelector('.status-badge')).toHaveClass('status-badge--progress');
  });

  it('marks the icon as decorative for assistive tech', () => {
    const { container } = render(<StatusBadge label="Failed" tone="danger" icon="✕" />);
    expect(container.querySelector('.status-badge__icon')).toHaveAttribute('aria-hidden', 'true');
  });
});
