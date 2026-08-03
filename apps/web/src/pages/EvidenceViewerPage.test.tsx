import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EvidenceViewerPage } from './EvidenceViewerPage.js';

const getStateMock = vi.fn();
const listReposMock = vi.fn();

vi.mock('../api/tasks.js', () => ({
  tasksApi: { getState: (r: string, t: string) => getStateMock(r, t) },
}));
vi.mock('../api/client.js', () => ({ api: { listRepositories: () => listReposMock() } }));

const repositories = [
  { id: 'repo-1', name: 'alpha', canonicalPath: '/a', defaultBranch: 'main', trusted: true, createdAt: '', updatedAt: '' },
];

function stateWith(ids: string[]) {
  return {
    state: {
      taskId: 'task-9',
      repositoryId: 'repo-1',
      phase: 'verify',
      condition: 'running',
      deliveryState: 'not-started',
      attemptNumber: 1,
      latestCandidateEvidenceIds: ids,
      openFindingIds: [],
      tokenUsageTotal: { inputTokens: 0, outputTokens: 0 },
      runtimeMsByPhase: {},
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listReposMock.mockResolvedValue(repositories);
});

async function lookUp() {
  const user = userEvent.setup();
  await waitFor(() => expect(document.querySelector('datalist option')).not.toBeNull());
  await user.type(screen.getByLabelText('Repository'), 'alpha');
  await user.type(screen.getByLabelText('Task ID'), 'task-9');
  await user.click(screen.getByRole('button', { name: 'Look up' }));
}

describe('EvidenceViewerPage', () => {
  it('lists candidate evidence ids for the looked-up task', async () => {
    getStateMock.mockResolvedValue(stateWith(['ev-1', 'ev-2']));
    render(<EvidenceViewerPage />);
    await lookUp();
    expect(await screen.findByText('ev-1')).toBeInTheDocument();
    expect(screen.getByText('ev-2')).toBeInTheDocument();
  });

  it('reports when no evidence has been recorded', async () => {
    getStateMock.mockResolvedValue(stateWith([]));
    render(<EvidenceViewerPage />);
    await lookUp();
    expect(await screen.findByText('No candidate evidence recorded for this task yet.')).toBeInTheDocument();
  });
});
