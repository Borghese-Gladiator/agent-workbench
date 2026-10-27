import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@workbench/core';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api', () => ({ api: { listTasks: vi.fn() } }));

import { api } from '@/api';
import { usePageHeader } from '@/components/PageHeader';
import { App } from './App';

function task(over: Partial<Task>): Task {
  return {
    id: over.id ?? 't1',
    projectId: 'p1',
    title: 'Task',
    rawRequest: '',
    stage: over.stage ?? 'implementation',
    status: over.status ?? 'active',
    worktreeId: null,
    worktreeMode: 'worktree' as const,
    skipE2e: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    rev: 0,
    ...over,
  };
}

function StubPage({ title }: { title: string }) {
  usePageHeader({ title });
  return <div>stub: {title}</div>;
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <App />,
        children: [
          { index: true, element: <StubPage title="Task Board" /> },
          { path: 'projects', element: <StubPage title="Projects" /> },
          { path: 'usage', element: <StubPage title="Token Usage" /> },
          { path: 'tasks/:id', element: <div>detail</div> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

describe('App shell', () => {
  beforeEach(() => {
    vi.mocked(api.listTasks).mockReset();
    vi.mocked(api.listTasks).mockResolvedValue([]);
    localStorage.clear();
  });

  it('renders two sidebar zones with Projects + Token Usage in the Config zone', () => {
    renderAt('/');
    expect(screen.getByText('Workflow')).toBeInTheDocument();
    expect(screen.getByText('Config')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Task Board/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Projects/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Token Usage/ })).toBeInTheDocument();
  });

  it('marks the active route', () => {
    renderAt('/projects');
    expect(screen.getByRole('link', { name: /Projects/ })).toHaveClass('font-medium');
    expect(screen.getByRole('link', { name: /Task Board/ })).not.toHaveClass('font-medium');
  });

  it('shows the contextual top-bar title for the active page', () => {
    renderAt('/usage');
    expect(screen.getByRole('heading', { name: 'Token Usage' })).toBeInTheDocument();
  });

  it('suppresses the top bar on Task Detail (page sets no header)', () => {
    renderAt('/tasks/abc');
    // Only the sidebar app title remains; no contextual <h2> heading.
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
  });

  it('badges Task Board with the count of tasks parked at a human-approval gate', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([
      task({ id: 'a', status: 'active', stage: 'human_plan_approval' }),
      task({ id: 'b', status: 'active', stage: 'human_review' }),
      task({ id: 'c', status: 'active', stage: 'implementation' }), // not a gate
      task({ id: 'd', status: 'done', stage: 'human_plan_approval' }), // not active
    ]);
    renderAt('/');
    const board = await screen.findByRole('link', { name: /Task Board/ });
    await waitFor(() => expect(within(board).queryByText('2')).toBeInTheDocument());
  });

  it('shows no badge when nothing awaits approval', async () => {
    vi.mocked(api.listTasks).mockResolvedValue([
      task({ id: 'a', status: 'active', stage: 'implementation' }),
    ]);
    renderAt('/');
    await waitFor(() => expect(api.listTasks).toHaveBeenCalled());
    const board = screen.getByRole('link', { name: /Task Board/ });
    expect(within(board).queryByText(/^\d+$/)).not.toBeInTheDocument();
  });

  it('collapses the sidebar to an icon rail (hiding labels) and persists the choice', async () => {
    renderAt('/');
    // Expanded: section labels + the nav link's text label are visible.
    expect(screen.getByText('Workflow')).toBeInTheDocument();
    const board = screen.getByRole('link', { name: /Task Board/ });
    expect(within(board).getByText('Task Board')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    // Collapsed: the section label + the nav link's text label are gone, but the
    // link (icon, named via title) remains reachable.
    expect(screen.queryByText('Workflow')).not.toBeInTheDocument();
    const collapsedBoard = screen.getByRole('link', { name: 'Task Board' });
    expect(within(collapsedBoard).queryByText('Task Board')).not.toBeInTheDocument();
    expect(localStorage.getItem('workbench:sidebar-collapsed')).toBe('1');
  });

  it('restores the collapsed state from localStorage on mount', () => {
    localStorage.setItem('workbench:sidebar-collapsed', '1');
    renderAt('/');
    expect(screen.queryByText('Workflow')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });
});
