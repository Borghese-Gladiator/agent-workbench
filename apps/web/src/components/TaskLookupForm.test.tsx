import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskLookupForm } from './TaskLookupForm.js';

const listReposMock = vi.fn();

vi.mock('../api/client.js', () => ({
  api: { listRepositories: () => listReposMock() },
}));

const repositories = [
  { id: 'repo-1', name: 'alpha', canonicalPath: '/a', defaultBranch: 'main', trusted: true, createdAt: '', updatedAt: '' },
];

beforeEach(() => {
  vi.clearAllMocks();
  listReposMock.mockResolvedValue(repositories);
});

describe('TaskLookupForm', () => {
  it('keeps Look up disabled until a repository and task id are provided', async () => {
    const onLookup = vi.fn();
    const { container } = render(<TaskLookupForm busy={false} onLookup={onLookup} />);
    await waitFor(() => expect(container.querySelector('datalist option')).not.toBeNull());
    const button = screen.getByRole('button', { name: 'Look up' });
    expect(button).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Repository'), 'alpha');
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Task ID'), 'task-9');
    expect(button).toBeEnabled();
  });

  it('yields the resolved repository id and task id on submit', async () => {
    const onLookup = vi.fn();
    const { container } = render(<TaskLookupForm busy={false} onLookup={onLookup} />);
    await waitFor(() => expect(container.querySelector('datalist option')).not.toBeNull());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Repository'), 'alpha');
    await user.type(screen.getByLabelText('Task ID'), 'task-9');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(onLookup).toHaveBeenCalledWith('repo-1', 'task-9');
  });
});
