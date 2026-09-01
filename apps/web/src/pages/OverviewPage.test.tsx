import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewResponse } from '../api/client.js';
import { OverviewPage } from './OverviewPage.js';

const getMock = vi.fn();
vi.mock('../api/client.js', () => ({
  overviewApi: { get: () => getMock() },
}));
vi.mock('../hooks/useTaskListLiveRefresh.js', () => ({
  useTaskListLiveRefresh: () => undefined,
}));

const overview: OverviewResponse = {
  factoryHealth: { total: 3, running: 1, awaitingHuman: 1, blocked: 0, failed: 1, completed: 0 },
  needsAttention: [
    {
      taskId: 'task-1',
      repositoryId: 'repo-1',
      repositoryName: 'demo',
      workflowId: 'wf-1',
      prompt: 'Fix the flake',
      phase: 'qa',
      condition: 'awaiting-human',
      deliveryState: 'none',
      size: 'S',
      createdAt: 'x',
      updatedAt: 'x',
      derivedStatus: 'awaiting-human',
      attemptCount: 1,
      openFindingCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      pendingGateReason: 'task-contract-approval',
      candidateSha: null,
      pullRequestUrl: null,
      title: 'Fix the flake',
      retryOfTaskId: null,
      rootTaskId: null,
      indexedAt: 'x',
    },
  ],
  currentState: { running: 1, 'awaiting-human': 1, failed: 1 },
  recentActivity: [],
};

afterEach(() => getMock.mockReset());

describe('OverviewPage', () => {
  it('renders the factory-health strip and needs-attention set', async () => {
    getMock.mockResolvedValue(overview);
    render(
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Fix the flake')).toBeInTheDocument();
    // health strip label (unique to the StatTile)
    await waitFor(() => expect(screen.getByText('Awaiting human')).toBeInTheDocument());
    // "Completed" appears in both the health strip and the current-state list.
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
  });
});
