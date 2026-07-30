import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateTaskModal } from './CreateTaskModal.js';
import type { Repository } from '../api/client.js';

const repositories: Repository[] = [
  {
    id: 'repo-uuid-1',
    canonicalPath: '/repos/browser-games',
    name: 'browser-games',
    defaultBranch: 'main',
    trusted: true,
    createdAt: '2026-07-30T10:00:00Z',
    updatedAt: '2026-07-30T10:00:00Z',
  },
];

function renderModal(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const onCancel = vi.fn();
  render(<CreateTaskModal repositories={repositories} onCancel={onCancel} onSubmit={onSubmit} />);
  return { onSubmit, onCancel };
}

describe('CreateTaskModal', () => {
  it('renders as a labelled dialog with named fields', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: 'Create task' })).toBeInTheDocument();
    expect(screen.getByLabelText('Repository')).toBeInTheDocument();
    expect(screen.getByLabelText('Task prompt')).toBeInTheDocument();
  });

  it('keeps Create disabled until both fields are valid', async () => {
    const user = userEvent.setup();
    renderModal();
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText('Repository'), 'browser-games');
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText('Task prompt'), 'Add a footer');
    expect(create).toBeEnabled();
  });

  it('submits the resolved repository id (not the typed name) and prompt', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderModal();
    await user.type(screen.getByLabelText('Repository'), 'browser-games');
    await user.type(screen.getByLabelText('Task prompt'), '  Add a footer  ');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledWith({ repositoryId: 'repo-uuid-1', prompt: 'Add a footer' });
  });

  it('surfaces an error and preserves the values on failure', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error('daemon down'));
    renderModal(onSubmit);
    await user.type(screen.getByLabelText('Repository'), 'browser-games');
    await user.type(screen.getByLabelText('Task prompt'), 'Add a footer');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('daemon down'));
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Add a footer');
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderModal();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});
