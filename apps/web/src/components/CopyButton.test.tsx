import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from './CopyButton.js';

/**
 * NOTE: @testing-library/user-event's setup() installs its own navigator.clipboard stub, which
 * would shadow a spy defined beforehand. We call setup() first, then spy on the clipboard it
 * installed, so the assertion sees the component's real write.
 */
describe('CopyButton', () => {
  it('exposes the provided accessible label and copies the value', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<CopyButton value="the-value" label="Copy the value" />);
    await user.click(screen.getByRole('button', { name: 'Copy the value' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledWith('the-value');
  });

  it('shows a Copied confirmation after copying', async () => {
    const user = userEvent.setup();
    render(<CopyButton value="x" label="Copy x" />);
    await user.click(screen.getByRole('button', { name: 'Copy x' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});
