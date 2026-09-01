import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DERIVED_STATUS_LABEL } from '@/lib/task-status';
import type { TaskSummary } from '../api/tasks.js';
import { TaskBoard } from './TaskBoard.js';

const listMock = vi.fn();
vi.mock('../api/tasks.js', () => ({
  tasksApi: { list: () => listMock() },
}));
vi.mock('../hooks/useTaskListLiveRefresh.js', () => ({
  useTaskListLiveRefresh: () => undefined,
}));

function task(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    taskId: 'task-1',
    repositoryId: 'repo-1',
    repositoryName: 'demo',
    workflowId: 'wf-1',
    prompt: 'Add a widget',
    phase: 'implement',
    condition: 'running',
    deliveryState: 'none',
    size: 'M',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    derivedStatus: 'running',
    attemptCount: 1,
    openFindingCount: 0,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: null,
    pendingGateReason: null,
    candidateSha: null,
    pullRequestUrl: null,
    title: null,
    retryOfTaskId: null,
    rootTaskId: null,
    indexedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  listMock.mockReset();
});

function renderBoard() {
  return render(
    <MemoryRouter>
      <TaskBoard />
    </MemoryRouter>,
  );
}

describe('TaskBoard', () => {
  it('renders a column for exactly the derived-status label set', async () => {
    listMock.mockResolvedValue([]);
    renderBoard();
    await waitFor(() => {
      for (const label of Object.values(DERIVED_STATUS_LABEL)) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    });
  });

  it('renders projection fields on a card and never a runId', async () => {
    listMock.mockResolvedValue([
      task({ title: 'Add a widget', derivedStatus: 'planning', phase: 'plan' }),
    ]);
    renderBoard();

    expect(await screen.findByText('Add a widget')).toBeInTheDocument();
    // repo label + phase + compact token total render on the card.
    expect(screen.getByText('demo')).toBeInTheDocument();
    expect(screen.getByText('plan')).toBeInTheDocument();
    expect(screen.getByText(/1\.5k tok/)).toBeInTheDocument();
    // The card must not expose the workflow/run id.
    expect(screen.queryByText(/wf-1/)).not.toBeInTheDocument();
  });
});
