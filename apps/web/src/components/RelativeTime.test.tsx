import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RelativeTime } from './RelativeTime.js';

describe('RelativeTime', () => {
  it('renders a relative label with the exact time in the title and a machine-readable dateTime', () => {
    const iso = new Date(Date.now() - 3 * 60000).toISOString();
    render(<RelativeTime iso={iso} />);
    const time = screen.getByText('3 minutes ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', iso);
    expect(time).toHaveAttribute('title');
  });
});
