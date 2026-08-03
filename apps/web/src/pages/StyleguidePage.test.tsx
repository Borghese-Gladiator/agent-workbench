import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StyleguidePage } from './StyleguidePage.js';
import { ToastProvider } from '../components/Toast.js';

function renderPage() {
  render(
    <ToastProvider>
      <StyleguidePage />
    </ToastProvider>,
  );
}

describe('StyleguidePage', () => {
  it('renders every primitive section', () => {
    renderPage();
    for (const heading of ['Buttons', 'Status badges', 'Notices', 'Form field', 'Inline controls', 'Overlays', 'Loading skeleton']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
  });

  it('opens the example modal from the styleguide', async () => {
    renderPage();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open modal' }));
    expect(screen.getByRole('dialog', { name: 'Example modal' })).toBeInTheDocument();
  });

  it('fires a toast', async () => {
    renderPage();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fire toast' }));
    expect(screen.getByRole('status')).toHaveTextContent('Hello from a toast');
  });
});
