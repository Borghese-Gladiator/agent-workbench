import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalsPage } from './ApprovalsPage.js';

const getStateMock = vi.fn();
const listReposMock = vi.fn();

vi.mock('../api/tasks.js', () => ({
  tasksApi: {
    getState: (r: string, t: string) => getStateMock(r, t),
    approveContract: vi.fn(),
    rejectContract: vi.fn(),
    approvePlan: vi.fn(),
    rejectPlan: vi.fn(),
  },
}));
vi.mock('../api/client.js', () => ({ api: { listRepositories: () => listReposMock() } }));

const repositories = [
  { id: 'repo-1', name: 'alpha', canonicalPath: '/a', defaultBranch: 'main', trusted: true, createdAt: '', updatedAt: '' },
];

function baseState(gate: unknown) {
  return {
    state: {
      taskId: 'task-9',
      repositoryId: 'repo-1',
      phase: 'plan',
      condition: 'awaiting-human',
      deliveryState: 'not-started',
      attemptNumber: 1,
      latestCandidateEvidenceIds: [],
      openFindingIds: [],
      pendingHumanGate: gate,
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

describe('ApprovalsPage', () => {
  it('renders the pending gate returned for the looked-up task', async () => {
    getStateMock.mockResolvedValue(
      baseState({ id: 'g1', taskId: 'task-9', phase: 'plan', reason: 'task-contract-approval', summary: 'Approve me', createdAt: '' }),
    );
    render(<ApprovalsPage />);
    await lookUp();
    expect(await screen.findByRole('heading', { name: 'Pending human gate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve contract' })).toBeInTheDocument();
  });

  it('reports when there is no pending gate', async () => {
    getStateMock.mockResolvedValue(baseState(undefined));
    render(<ApprovalsPage />);
    await lookUp();
    expect(await screen.findByText('No pending human gate for this task.')).toBeInTheDocument();
  });
});
