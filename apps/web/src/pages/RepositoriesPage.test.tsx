import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RepositoriesPage } from './RepositoriesPage.js';

const listMock = vi.fn();
const addMock = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    listRepositories: () => listMock(),
    addRepository: (path: string) => addMock(path),
  },
}));

function renderPage() {
  render(
    <MemoryRouter>
      <RepositoriesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('RepositoriesPage', () => {
  it('lists repositories with a trusted/untrusted badge', async () => {
    listMock.mockResolvedValue([
      { id: '1', name: 'alpha', canonicalPath: '/a', defaultBranch: 'main', trusted: true, createdAt: '', updatedAt: '' },
      { id: '2', name: 'beta', canonicalPath: '/b', defaultBranch: 'main', trusted: false, createdAt: '', updatedAt: '' },
    ]);
    renderPage();
    expect(await screen.findByRole('link', { name: 'alpha' })).toBeInTheDocument();
    expect(screen.getByText('Trusted')).toBeInTheDocument();
    expect(screen.getByText('Untrusted')).toBeInTheDocument();
  });

  it('shows the empty state when there are no repositories', async () => {
    listMock.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No repositories registered yet.')).toBeInTheDocument();
  });

  it('adds a repository via the labelled path field', async () => {
    listMock.mockResolvedValue([]);
    addMock.mockResolvedValue({});
    renderPage();
    await screen.findByText('No repositories registered yet.');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Repository path'), '/repos/new');
    await user.click(screen.getByRole('button', { name: 'Add repository' }));
    expect(addMock).toHaveBeenCalledWith('/repos/new');
  });

  it('surfaces an error when loading fails', async () => {
    listMock.mockRejectedValue(new Error('nope'));
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('nope'));
  });
});
