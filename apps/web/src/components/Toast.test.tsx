import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from './Toast.js';
import { Button } from './Button.js';

function Harness() {
  const toast = useToast();
  return (
    <Button variant="primary" onClick={() => toast.show('Saved', 'success')}>
      Fire
    </Button>
  );
}

describe('Toast', () => {
  it('renders a message in a polite live region when shown', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fire' }));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Saved');
  });

  it('throws if useToast is used without a provider', () => {
    expect(() => render(<Harness />)).toThrow(/ToastProvider/);
  });
});
