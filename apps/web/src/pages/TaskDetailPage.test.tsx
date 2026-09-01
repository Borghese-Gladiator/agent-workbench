import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SemanticEvent } from '../api/events.js';
import type { TaskStateResponse, TaskWorkflowState } from '../api/tasks.js';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ repositoryId: 'repo-1', taskId: 'task-1' }),
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

const getStateMock = vi.fn();
vi.mock('../api/tasks.js', () => ({
  tasksApi: {
    getState: (...args: unknown[]) => getStateMock(...args),
    cancel: vi.fn(),
  },
}));

// Drive the timeline: TaskDetailPage reads `events` from useEventStream; we control what it returns.
let streamedEvents: SemanticEvent[] = [];
vi.mock('../hooks/useEventStream.js', () => ({
  useEventStream: () => ({ events: streamedEvents, status: 'connected' }),
}));

import { TaskDetailPage } from './TaskDetailPage.js';

function baseState(overrides: Partial<TaskWorkflowState> = {}): TaskWorkflowState {
  return {
    taskId: 'task-1',
    repositoryId: 'repo-1',
    phase: 'plan',
    condition: 'running',
    deliveryState: 'none',
    attemptNumber: 1,
    latestCandidateEvidenceIds: [],
    openFindingIds: [],
    tokenUsageTotal: { inputTokens: 0, outputTokens: 0 },
    runtimeMsByPhase: {},
    ...overrides,
  };
}

function stateResponse(state: TaskWorkflowState): TaskStateResponse {
  return { state, openFindings: [], pendingHumanGate: undefined, maintainabilityFindings: [] };
}

function ev(sequence: number): SemanticEvent {
  return {
    id: `e${sequence}`,
    runId: 'task-1-run',
    sequence,
    occurredAt: '2026-08-04T00:00:00.000Z',
    phase: 'plan',
    phaseAttemptId: 'task-1-plan-1',
    producer: 'planner',
    type: 'phase-started',
    summary: 'x',
  };
}

beforeEach(() => {
  streamedEvents = [];
  getStateMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TaskDetailPage live status header', () => {
  it('re-queries getState within the debounce when a new event arrives, and the badge updates', async () => {
    getStateMock.mockResolvedValueOnce(stateResponse(baseState({ condition: 'running' })));

    const { rerender } = render(<TaskDetailPage />);

    // Initial poll load.
    await waitFor(() => expect(screen.getByText('running')).toBeInTheDocument());
    const callsAfterMount = getStateMock.mock.calls.length;

    // A new streamed event arrives; the next getState reflects the advanced condition.
    getStateMock.mockResolvedValueOnce(stateResponse(baseState({ condition: 'completed' })));
    vi.useFakeTimers();
    streamedEvents = [ev(0)];
    rerender(<TaskDetailPage />);

    act(() => vi.advanceTimersByTime(300));
    vi.useRealTimers();

    await waitFor(() => expect(getStateMock.mock.calls.length).toBe(callsAfterMount + 1));
    await waitFor(() => expect(screen.getByText('completed')).toBeInTheDocument());
  });
});
