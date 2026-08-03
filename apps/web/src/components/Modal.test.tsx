import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal.js';

describe('Modal', () => {
  it('renders a labelled dialog and focuses the first focusable element', () => {
    render(
      <Modal title="My dialog" onClose={() => {}}>
        <button type="button">Inside</button>
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: 'My dialog' })).toBeInTheDocument();
    // First focusable is the header Close button.
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Esc" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(
      <Modal title="X" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('restores focus to the previously focused element on unmount', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Opener';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(
      <Modal title="Return" onClose={() => {}}>
        <button type="button">Inside</button>
      </Modal>,
    );
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('traps Tab focus within the dialog', async () => {
    const user = userEvent.setup();
    render(
      <Modal title="Trap" onClose={() => {}}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </Modal>,
    );
    const close = screen.getByRole('button', { name: 'Close dialog' });
    const last = screen.getByRole('button', { name: 'Last' });
    // Shift+Tab from the first focusable (close) wraps to the last.
    close.focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(last).toHaveFocus();
  });
});
