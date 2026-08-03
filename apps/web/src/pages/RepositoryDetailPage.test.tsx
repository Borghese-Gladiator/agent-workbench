import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RepositoryDetailPage } from './RepositoryDetailPage.js';

const getMock = vi.fn();
const refreshMock = vi.fn();
const approveMock = vi.fn();

vi.mock('../api/client.js', () => ({
  api: {
    getRepository: (id: string) => getMock(id),
    refreshRepository: (id: string) => refreshMock(id),
    approveRepository: (id: string) => approveMock(id),
  },
}));

function renderAt(id = 'repo-1') {
  render(
    <MemoryRouter initialEntries={[`/repositories/${id}`]}>
      <Routes>
        <Route path="/repositories/:id" element={<RepositoryDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const repo = (trusted: boolean) => ({
  repository: { id: 'repo-1', name: 'alpha', canonicalPath: '/a', defaultBranch: 'main', trusted, createdAt: '', updatedAt: '' },
  latestSnapshot: undefined,
});

beforeEach(() => vi.clearAllMocks());

describe('RepositoryDetailPage', () => {
  it('shows the trusted badge and hides Approve for a trusted repo', async () => {
    getMock.mockResolvedValue(repo(true));
    renderAt();
    expect(await screen.findByRole('heading', { name: 'alpha' })).toBeInTheDocument();
    expect(screen.getByText('Trusted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('offers Approve for an untrusted repo and calls the API', async () => {
    getMock.mockResolvedValue(repo(false));
    approveMock.mockResolvedValue(undefined);
    renderAt();
    await screen.findByRole('heading', { name: 'alpha' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('repo-1'));
  });

  it('refreshes on demand', async () => {
    getMock.mockResolvedValue(repo(true));
    refreshMock.mockResolvedValue(undefined);
    renderAt();
    await screen.findByRole('heading', { name: 'alpha' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledWith('repo-1'));
  });
});
