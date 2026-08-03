import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { TaskDetailPage } from './TaskDetailPage.js';

const getStateMock = vi.fn();
const cancelMock = vi.fn();

vi.mock('../api/tasks.js', () => ({
  tasksApi: {
    getState: (r: string, t: string) => getStateMock(r, t),
    cancel: (r: string, t: string) => cancelMock(r, t),
    approveContract: vi.fn(),
    rejectContract: vi.fn(),
    approvePlan: vi.fn(),
    rejectPlan: vi.fn(),
  },
}));
vi.mock('../hooks/useEventStream.js', () => ({
  useEventStream: () => ({ events: [], connected: true }),
}));

function stateResult(condition: string) {
  return {
    state: {
      taskId: 'ed33645f-aaaa-bbbb-cccc-000011112222',
      repositoryId: 'repo-uuid-1',
      phase: 'implement',
      condition,
      deliveryState: 'branch-ready',
      attemptNumber: 1,
      latestCandidateEvidenceIds: [],
      openFindingIds: [],
      pendingHumanGate: undefined,
      tokenUsageTotal: { inputTokens: 5, outputTokens: 7 },
      runtimeMsByPhase: {},
    },
  };
}

function renderAt() {
  render(
    <MemoryRouter initialEntries={['/tasks/repo-uuid-1/ed33645f-aaaa-bbbb-cccc-000011112222']}>
      <Routes>
        <Route path="/tasks/:repositoryId/:taskId" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TaskDetailPage', () => {
  it('shows the short task id and copies the full id', async () => {
    getStateMock.mockResolvedValue(stateResult('running'));
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderAt();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ed33645f'));
    await user.click(screen.getByRole('button', { name: 'Copy full task ID' }));
    expect(writeText).toHaveBeenCalledWith('ed33645f-aaaa-bbbb-cccc-000011112222');
  });

  it('disables Cancel for a terminal task', async () => {
    getStateMock.mockResolvedValue(stateResult('completed'));
    renderAt();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
  });

  it('enables Cancel for a running task and signals cancel', async () => {
    getStateMock.mockResolvedValue(stateResult('running'));
    cancelMock.mockResolvedValue({ ok: true });
    renderAt();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith('repo-uuid-1', 'ed33645f-aaaa-bbbb-cccc-000011112222'));
  });
});
