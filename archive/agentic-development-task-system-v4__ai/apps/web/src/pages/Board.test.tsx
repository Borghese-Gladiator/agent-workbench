import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Project, QueueEntry, Task } from '@workbench/core';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageHeaderProvider, usePageHeaderState } from '@/components/PageHeader';
import { Board } from './Board';

vi.mock('../api.js', () => ({
  api: { listTasks: vi.fn(), listProjects: vi.fn(), listQueue: vi.fn(), createTask: vi.fn() },
}));

import { api } from '../api.js';

function task(over: Partial<Task>): Task {
  return {
    id: over.id ?? 't1',
    projectId: over.projectId ?? 'p1',
    title: over.title ?? 'Task',
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

function queueEntry(over: Partial<QueueEntry> & { taskId: string }): QueueEntry {
  return {
    id: over.id ?? `q-${over.taskId}`,
    status: over.status ?? 'queued',
    priority: over.priority ?? 0,
    dependsOnIds: over.dependsOnIds ?? [],
    enqueuedAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

function proj(id: string, name: string): Project {
  return {
    id,
    name,
    description: '',
    repoPath: '/r',
    defaultBranch: 'main',
    agentRuntime: 'mock',
    runtimeConfig: {},
    externalTools: [],
    deliveryPolicy: 'create_pr',
    testCommand: '',
    lintCommand: '',
    typecheckCommand: '',
    e2eCommand: '',
    devCommand: '',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function TopBarStub() {
  const header = usePageHeaderState();
  return <>{header?.action}</>;
}

function renderBoard(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PageHeaderProvider>
        <TopBarStub />
        <Board />
      </PageHeaderProvider>
    </MemoryRouter>,
  );
}

describe('Board', () => {
  beforeEach(() => {
    vi.mocked(api.listTasks).mockReset();
    vi.mocked(api.listProjects).mockReset();
    vi.mocked(api.listQueue).mockReset().mockResolvedValue([]);
  });

  it('renders no approval-pill banner, no bell, no shell/terminal button', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([proj('p1', 'Alpha')]);
    vi.mocked(api.listTasks).mockResolvedValue([
      task({ id: 't1', stage: 'human_plan_approval', status: 'active' }),
    ]);
    renderBoard();
    await screen.findByText('Task');
    expect(screen.queryByText(/need human approval/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /notification|bell|shell|terminal/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    // The per-card "needs approval" badge is still kept.
    expect(screen.getByText('needs approval')).toBeInTheDocument();
  });

  it('project filter narrows cards to the chosen project', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([proj('p1', 'Alpha'), proj('p2', 'Beta')]);
    vi.mocked(api.listTasks).mockResolvedValue([
      task({ id: 't1', title: 'Alpha task', projectId: 'p1' }),
      task({ id: 't2', title: 'Beta task', projectId: 'p2' }),
    ]);
    renderBoard();
    await screen.findByText('Alpha task');
    expect(screen.getByText('Beta task')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('combobox', { name: /Filter by project/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Alpha' }));

    expect(screen.getByText('Alpha task')).toBeInTheDocument();
    expect(screen.queryByText('Beta task')).not.toBeInTheDocument();
  });

  it('pre-filters from a ?project=<id> URL param', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([proj('p1', 'Alpha'), proj('p2', 'Beta')]);
    vi.mocked(api.listTasks).mockResolvedValue([
      task({ id: 't1', title: 'Alpha task', projectId: 'p1' }),
      task({ id: 't2', title: 'Beta task', projectId: 'p2' }),
    ]);
    renderBoard('/?project=p1');
    await screen.findByText('Alpha task');
    expect(screen.queryByText('Beta task')).not.toBeInTheDocument();
    // The dropdown reflects the URL-driven filter.
    expect(screen.getByRole('combobox', { name: /Filter by project/ })).toHaveTextContent('Alpha');
  });

  it('cards show project name', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([proj('p1', 'Alpha')]);
    vi.mocked(api.listTasks).mockResolvedValue([task({ id: 't1', title: 'T', projectId: 'p1' })]);
    renderBoard();
    const card = (await screen.findByText('T')).closest('a')!;
    expect(within(card).getByText('Alpha')).toBeInTheDocument();
  });

  it('collapses lifecycle stages into board columns with the right counts', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([proj('p1', 'Alpha')]);
    vi.mocked(api.listTasks).mockResolvedValue([
      // 'In Progress' bucket spans implementation / verification / agent_self_review.
      task({ id: 't1', title: 'One', stage: 'implementation' }),
      task({ id: 't2', title: 'Two', stage: 'agent_self_review' }),
      // 'Planning' bucket — discovery is a PRE-implementation stage.
      task({ id: 't3', title: 'Three', stage: 'discovery' }),
    ]);
    renderBoard();

    const inProgress = (await screen.findByRole('heading', { name: 'In Progress' })).closest(
      'section',
    )!;
    expect(within(inProgress).getByText('2')).toBeInTheDocument();
    const planning = screen.getByRole('heading', { name: 'Planning' }).closest('section')!;
    expect(within(planning).getByText('1')).toBeInTheDocument();
  });

  it('always shows every board column, even empty ones (Linear-style)', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([proj('p1', 'Alpha')]);
    // Only the Done column has a task; the human-gate columns are empty.
    vi.mocked(api.listTasks).mockResolvedValue([
      task({ id: 't1', title: 'One', stage: 'closeout' }),
    ]);
    renderBoard();

    await screen.findByText('One');
    // An empty gate column still renders with a 0 count.
    const review = screen.getByRole('heading', { name: 'Needs Review' }).closest('section')!;
    expect(within(review).getByText('0')).toBeInTheDocument();
    const done = screen.getByRole('heading', { name: 'Done' }).closest('section')!;
    expect(within(done).getByText('1')).toBeInTheDocument();
  });

  it('card shows a created-date footer and links by id, but does not surface the id', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([proj('p1', 'Alpha')]);
    vi.mocked(api.listTasks).mockResolvedValue([
      task({ id: 'CORE-1', title: 'T', createdAt: '2026-04-29T00:00:00Z' }),
    ]);
    renderBoard();
    const card = (await screen.findByText('T')).closest('a')!;
    expect(within(card).getByText(/^Created /)).toBeInTheDocument();
    expect(card).toHaveAttribute('href', '/tasks/CORE-1');
    // The id is intentionally not shown on the card (project name leads instead).
    expect(within(card).queryByText('CORE-1')).not.toBeInTheDocument();
    expect(within(card).getByText('Alpha')).toBeInTheDocument();
  });

  it('shows a "Blocked by <title>" badge while a dependency is unmet', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([proj('p1', 'Alpha')]);
    vi.mocked(api.listTasks).mockResolvedValue([
      task({ id: 'dep', title: 'Lexer' }),
      task({ id: 'blocked', title: 'Parser' }),
    ]);
    vi.mocked(api.listQueue).mockResolvedValue([
      queueEntry({ id: 'q-dep', taskId: 'dep', status: 'running' }),
      queueEntry({ id: 'q-blocked', taskId: 'blocked', dependsOnIds: ['q-dep'] }),
    ]);
    renderBoard();

    const blockedCard = (await screen.findByText('Parser')).closest('a')!;
    expect(within(blockedCard).getByText(/Blocked by “Lexer”/)).toBeInTheDocument();
    // The unblocking task itself shows no blocked badge.
    const depCard = screen.getByText('Lexer').closest('a')!;
    expect(within(depCard).queryByText(/Blocked by/)).not.toBeInTheDocument();
  });

  it('drops the blocked badge once the predecessor is done', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([proj('p1', 'Alpha')]);
    vi.mocked(api.listTasks).mockResolvedValue([
      task({ id: 'dep', title: 'Lexer' }),
      task({ id: 'blocked', title: 'Parser' }),
    ]);
    vi.mocked(api.listQueue).mockResolvedValue([
      queueEntry({ id: 'q-dep', taskId: 'dep', status: 'done' }),
      queueEntry({ id: 'q-blocked', taskId: 'blocked', dependsOnIds: ['q-dep'] }),
    ]);
    renderBoard();

    const blockedCard = (await screen.findByText('Parser')).closest('a')!;
    expect(within(blockedCard).queryByText(/Blocked by/)).not.toBeInTheDocument();
  });

  it('shows a priority chip only when priority is non-zero', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([proj('p1', 'Alpha')]);
    vi.mocked(api.listTasks).mockResolvedValue([
      task({ id: 'hi', title: 'Urgent' }),
      task({ id: 'lo', title: 'Normal' }),
    ]);
    vi.mocked(api.listQueue).mockResolvedValue([
      queueEntry({ taskId: 'hi', priority: 2 }),
      queueEntry({ taskId: 'lo', priority: 0 }),
    ]);
    renderBoard();

    const hiCard = (await screen.findByText('Urgent')).closest('a')!;
    expect(within(hiCard).getByText('P2')).toBeInTheDocument();
    const loCard = screen.getByText('Normal').closest('a')!;
    expect(within(loCard).queryByText(/^P\d/)).not.toBeInTheDocument();
  });
});
