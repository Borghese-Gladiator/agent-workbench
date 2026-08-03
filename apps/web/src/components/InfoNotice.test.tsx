import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoNotice } from './InfoNotice.js';

describe('InfoNotice', () => {
  it('renders the message, a learn-more link, and dismisses on demand', async () => {
    render(<InfoNotice learnMoreHref="https://docs.example">Heads up about something</InfoNotice>);
    expect(screen.getByText('Heads up about something')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Learn more' })).toHaveAttribute('href', 'https://docs.example');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(screen.queryByText('Heads up about something')).not.toBeInTheDocument();
  });

  it('omits the learn-more link when no href is given', () => {
    render(<InfoNotice>Just text</InfoNotice>);
    expect(screen.queryByRole('link', { name: 'Learn more' })).not.toBeInTheDocument();
  });
});
