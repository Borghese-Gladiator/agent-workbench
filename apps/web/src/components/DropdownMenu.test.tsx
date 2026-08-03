import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropdownMenu } from './DropdownMenu.js';

function renderMenu(onFirst = vi.fn()) {
  render(
    <DropdownMenu
      label="Row actions"
      items={[
        { label: 'View', onSelect: onFirst },
        { label: 'Delete', danger: true, onSelect: vi.fn() },
      ]}
    />,
  );
  return { onFirst };
}

describe('DropdownMenu', () => {
  it('is collapsed by default and toggles open via the labelled trigger', async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });

  it('invokes the item handler and closes on select', async () => {
    const user = userEvent.setup();
    const { onFirst } = renderMenu();
    await user.click(screen.getByRole('button', { name: 'Row actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'View' }));
    expect(onFirst).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: 'Row actions' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
