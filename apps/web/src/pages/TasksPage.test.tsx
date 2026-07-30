import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { TasksPage } from './TasksPage.js';
import { ToastProvider } from '../components/Toast.js';
import type { TaskSummary } from '../api/tasks.js';

const listMock = vi.fn();
const createMock = vi.fn();
const cancelMock = vi.fn();
const removeMock = vi.fn();
const listReposMock = vi.fn();

vi.mock('../api/tasks.js', () => ({
  tasksApi: {
    list: () => listMock(),
    create: (repositoryId: string, prompt: string) => createMock(repositoryId, prompt),
    cancel: (repositoryId: string, taskId: string) => cancelMock(repositoryId, taskId),
    remove: (repositoryId: string, taskId: string) => removeMock(repositoryId, taskId),
  },
}));

vi.mock('../api/client.js', () => ({
  api: { listRepositories: () => listReposMock() },
}));

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    taskId: 'ed33645f-aaaa-bbbb-cccc-dddddddddddd',
    repositoryId: 'repo-uuid-1',
    repositoryName: 'browser-games',
    workflowId: 'wf-1',
    prompt: 'Add README game count',
    phase: 'implement',
    condition: 'running',
    deliveryState: 'branch-ready',
    createdAt: '2026-07-30T11:55:00Z',
    updatedAt: '2026-07-30T11:56:00Z',
    ...overrides,
  };
}

const repositories = [
  {
    id: 'repo-uuid-1',
    canonicalPath: '/repos/browser-games',
    name: 'browser-games',
    defaultBranch: 'main',
    trusted: true,
    createdAt: '2026-07-30T10:00:00Z',
    updatedAt: '2026-07-30T10:00:00Z',
  },
];

function renderPage(initialEntry = '/tasks') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:repositoryId/:taskId" element={<div>Detail Page</div>} />
          <Route path="/repositories/:id" element={<div>Repo Page</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

let writeTextMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  listReposMock.mockResolvedValue(repositories);
  writeTextMock = vi.fn().mockResolvedValue(undefined);
  navigator.clipboard.writeText = writeTextMock as unknown as typeof navigator.clipboard.writeText;
});

describe('TasksPage', () => {
  it('shows skeleton rows while loading', () => {
    listMock.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector('.skeleton-row')).not.toBeNull();
  });

  it('renders a table row with short id, repo name, prompt, and status badge', async () => {
    listMock.mockResolvedValue([task()]);
    renderPage();
    expect(await screen.findByRole('button', { name: 'ed33645f' })).toBeInTheDocument();
    expect(screen.getByText('Add README game count')).toBeInTheDocument();
    expect(screen.getAllByText('browser-games').length).toBeGreaterThan(0);
    const badge = document.querySelector('.status-badge__label');
    expect(badge).toHaveTextContent('Running');
  });

  it('shows the empty state with a Create button when there are no tasks', async () => {
    listMock.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/No tasks yet/)).toBeInTheDocument();
  });

  it('shows an error panel with Retry when loading fails', async () => {
    listMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([task()]);
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('boom');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Add README game count')).toBeInTheDocument();
  });

  it('filters by search text and offers Clear filters on no match', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([task(), task({ taskId: 'ff00ff00-x', workflowId: 'wf-2', prompt: 'Add portal footer' })]);
    renderPage();
    await screen.findByText('Add README game count');
    await user.type(screen.getByRole('searchbox'), 'portal');
    await waitFor(() => expect(screen.queryByText('Add README game count')).not.toBeInTheDocument());
    expect(screen.getByText('Add portal footer')).toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz-no-match');
    expect(await screen.findByText('No tasks match the current filters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('navigates to the detail page when the short id is clicked', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([task()]);
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'ed33645f' }));
    expect(screen.getByText('Detail Page')).toBeInTheDocument();
  });

  it('copies the full task id and confirms via the row copy button', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([task()]);
    renderPage();
    await screen.findByRole('button', { name: 'ed33645f' });
    await user.click(screen.getByRole('button', { name: 'Copy full task ID' }));
    expect(writeTextMock).toHaveBeenCalledWith('ed33645f-aaaa-bbbb-cccc-dddddddddddd');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('requires confirmation before deleting a task', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([task()]);
    removeMock.mockResolvedValue({ removed: 'ed33645f' });
    renderPage();
    await screen.findByRole('button', { name: 'ed33645f' });
    await user.click(screen.getByRole('button', { name: /Actions for task/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete task' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete task?' });
    expect(removeMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }));
    expect(removeMock).toHaveBeenCalledWith('repo-uuid-1', 'ed33645f-aaaa-bbbb-cccc-dddddddddddd');
  });

  it('reads the status filter from the URL query params', async () => {
    listMock.mockResolvedValue([task({ condition: 'completed', phase: 'assimilate' })]);
    renderPage('/tasks?status=Running');
    await waitFor(() => expect(screen.queryByText('Add README game count')).not.toBeInTheDocument());
    expect(screen.getByText('No tasks match the current filters.')).toBeInTheDocument();
  });
});
