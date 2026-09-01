import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExecutionTreeResponse,
  TaskMediaArtifact,
  TaskStateResponse,
  TaskSummary,
} from '../api/tasks.js';
import { TaskDetailPage } from './TaskDetailPage.js';

const getState = vi.fn();
const executionTree = vi.fn();
const listMedia = vi.fn();
const list = vi.fn();

vi.mock('../api/tasks.js', () => ({
  tasksApi: {
    getState: (...a: unknown[]) => getState(...a),
    executionTree: (...a: unknown[]) => executionTree(...a),
    listMedia: (...a: unknown[]) => listMedia(...a),
    list: (...a: unknown[]) => list(...a),
    cancel: vi.fn(),
    create: vi.fn(),
  },
  artifactContentUrl: (id: string) => `/api/artifacts/${id}/content`,
}));

vi.mock('../hooks/useEventStream.js', () => ({
  useEventStream: () => ({ events: [], status: 'connected' }),
}));

const stateResponse: TaskStateResponse = {
  state: {
    taskId: 'task-1',
    repositoryId: 'repo-1',
    phase: 'qa',
    condition: 'running',
    deliveryState: 'none',
    attemptNumber: 2,
    size: 'M',
    phaseSet: ['specify', 'plan', 'implement', 'qa'],
    latestCandidateEvidenceIds: ['ev-1'],
    openFindingIds: [],
    tokenUsageTotal: { inputTokens: 1200, outputTokens: 800 },
    runtimeMsByPhase: { implement: 5000 },
  },
  openFindings: [],
  pendingHumanGate: undefined,
};

const tree: ExecutionTreeResponse = {
  taskId: 'task-1',
  phaseAttempts: [
    {
      id: 'pa-1',
      phase: 'implement',
      attemptNumber: 1,
      retryOf: null,
      startedAt: '2026-08-17T00:00:00.000Z',
      endedAt: '2026-08-17T00:01:00.000Z',
      outcome: 'succeeded',
      sessions: [],
    },
  ],
};

const media: TaskMediaArtifact[] = [
  { id: 'art-1', kind: 'qa-video', mediaType: 'video/webm', byteSize: 1000 },
];

const summary: TaskSummary = {
  taskId: 'task-1',
  repositoryId: 'repo-1',
  repositoryName: 'demo',
  workflowId: 'wf-1',
  prompt: 'Add a widget',
  phase: 'qa',
  condition: 'running',
  deliveryState: 'none',
  size: 'M',
  createdAt: 'x',
  updatedAt: 'x',
  derivedStatus: 'running',
  attemptCount: 2,
  openFindingCount: 0,
  inputTokens: 1200,
  outputTokens: 800,
  costUsd: null,
  pendingGateReason: null,
  candidateSha: 'abc123def456',
  pullRequestUrl: null,
  title: 'Add a widget',
  retryOfTaskId: null,
  rootTaskId: null,
  indexedAt: 'x',
};

afterEach(() => {
  vi.clearAllMocks();
});

function renderPage(initial = '/tasks/repo-1/task-1') {
  getState.mockResolvedValue(stateResponse);
  executionTree.mockResolvedValue(tree);
  listMedia.mockResolvedValue(media);
  list.mockResolvedValue([summary]);
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/tasks/:repositoryId/:taskId" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TaskDetailPage', () => {
  it('uses "Phase attempt" language distinct from "Retry as new task"', async () => {
    renderPage();
    expect(await screen.findByText(/Phase attempt 1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry as new task' })).toBeInTheDocument();
  });

  it('renders the Verification tab absorbing evidence and QA media', async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await screen.findByText(/Phase attempt 1/);

    await user.click(screen.getByRole('button', { name: 'Verification' }));

    await waitFor(() => expect(screen.getByText('ev-1')).toBeInTheDocument());
    expect(screen.getByText('QA media')).toBeInTheDocument();
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('deep-links to the Verification tab via ?tab=verification', async () => {
    renderPage('/tasks/repo-1/task-1?tab=verification');
    await waitFor(() => expect(screen.getByText('ev-1')).toBeInTheDocument());
  });
});
