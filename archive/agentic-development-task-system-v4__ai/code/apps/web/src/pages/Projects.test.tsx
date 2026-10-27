import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Project } from '@workbench/core';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageHeaderProvider, usePageHeaderState } from '@/components/PageHeader';
import { Projects } from './Projects';

/** Mirrors the shell: surfaces the page's contextual top-bar action so tests can reach it. */
function TopBarStub() {
  const header = usePageHeaderState();
  return <>{header?.action}</>;
}

vi.mock('../api.js', () => ({
  api: {
    listProjects: vi.fn(),
    createProject: vi.fn(),
    detectCommands: vi.fn(),
  },
}));

const NO_COMMANDS = {
  testCommand: '',
  lintCommand: '',
  typecheckCommand: '',
  e2eCommand: '',
  devCommand: '',
};

import { api } from '../api.js';

function project(over: Partial<Project>): Project {
  return {
    id: over.id ?? 'p1',
    name: over.name ?? 'Project',
    description: over.description ?? '',
    repoPath: over.repoPath ?? '/repo',
    defaultBranch: 'main',
    agentRuntime: over.agentRuntime ?? 'mock',
    runtimeConfig: over.runtimeConfig ?? {},
    externalTools: over.externalTools ?? [],
    deliveryPolicy: 'create_pr',
    testCommand: over.testCommand ?? '',
    lintCommand: '',
    typecheckCommand: '',
    e2eCommand: '',
    devCommand: '',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function renderProjects() {
  return render(
    <MemoryRouter>
      <PageHeaderProvider>
        <TopBarStub />
        <Projects />
      </PageHeaderProvider>
    </MemoryRouter>,
  );
}

describe('Projects (config-only registry)', () => {
  beforeEach(() => {
    vi.mocked(api.listProjects).mockReset();
    vi.mocked(api.createProject).mockReset();
    vi.mocked(api.detectCommands).mockReset();
  });

  it('renders config columns only — no branch, no analytics/health/search', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([project({ id: 'p1', name: 'Alpha' })]);
    renderProjects();
    expect(await screen.findByRole('columnheader', { name: 'Project Name' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Repository Path' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Runtime' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Delivery' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Build Commands' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /branch/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/uptime|latency|coverage|health/i)).not.toBeInTheDocument();
  });

  it('links each project name to the board filtered by its id', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([project({ id: 'proj_alpha', name: 'Alpha' })]);
    renderProjects();
    const link = await screen.findByRole('link', { name: 'Alpha' });
    expect(link).toHaveAttribute('href', '/?project=proj_alpha');
  });

  it('sorts rows alphabetically by name', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      project({ id: 'p1', name: 'Zebra' }),
      project({ id: 'p2', name: 'apple' }),
      project({ id: 'p3', name: 'Mango' }),
    ]);
    renderProjects();
    await screen.findByText('Mango');
    const rows = screen.getAllByRole('row').slice(1); // drop header row
    const names = rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(names).toEqual(['apple', 'Mango', 'Zebra']);
  });

  it('shows runtime as mock|claude, never a language', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      project({ id: 'p1', name: 'A', agentRuntime: 'claude' }),
    ]);
    renderProjects();
    const row = (await screen.findByText('A')).closest('tr')!;
    expect(within(row).getByText('Claude Code')).toBeInTheDocument();
    expect(screen.queryByText(/node\.js|golang|rust/i)).not.toBeInTheDocument();
  });

  it('shows the human-readable delivery policy in its column', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      project({ id: 'p1', name: 'A', deliveryPolicy: 'merge_to_master' }),
    ]);
    renderProjects();
    const row = (await screen.findByText('A')).closest('tr')!;
    expect(within(row).getByText('Merge to master')).toBeInTheDocument();
  });

  it('creates a project through the modal, defaulting delivery to merge_to_master', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    vi.mocked(api.createProject).mockResolvedValue(project({ id: 'new', name: 'New' }));
    renderProjects();
    await screen.findByText(/No projects yet/);

    await userEvent.click(screen.getByRole('button', { name: /New project/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name *'), 'New');
    await userEvent.type(within(dialog).getByLabelText('Description'), 'a repo');
    await userEvent.type(within(dialog).getByLabelText('Repo path *'), '/r');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    // Runtime defaults to claude (mock is test-only, hidden from the UI);
    // delivery policy defaults to merge_to_master.
    expect(api.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'New',
        description: 'a repo',
        repoPath: '/r',
        agentRuntime: 'claude',
        deliveryPolicy: 'merge_to_master',
      }),
    );
  });

  it('assembles the runtime model field into runtimeConfig on create', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    vi.mocked(api.createProject).mockResolvedValue(project({ id: 'new', name: 'New' }));
    renderProjects();
    await screen.findByText(/No projects yet/);

    await userEvent.click(screen.getByRole('button', { name: /New project/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name *'), 'New');
    await userEvent.type(within(dialog).getByLabelText('Repo path *'), '/r');
    // Claude is the default runtime and surfaces an optional model field.
    await userEvent.type(within(dialog).getByLabelText(/Model/), 'sonnet');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    expect(api.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeConfig: { model: 'sonnet' } }),
    );
    // The flat cfg* inputs must NOT leak into the payload.
    const payload = vi.mocked(api.createProject).mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('cfgModel');
  });

  it('hides the build-command inputs behind a collapsed section', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    renderProjects();
    await screen.findByText(/No projects yet/);

    await userEvent.click(screen.getByRole('button', { name: /New project/ }));
    const dialog = await screen.findByRole('dialog');
    // Collapsed by default: the disclosure toggle is present but the inputs aren't.
    expect(within(dialog).getByRole('button', { name: /Build commands/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(dialog).queryByLabelText('Test command')).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: /Build commands/ }));
    expect(within(dialog).getByLabelText('Test command')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Dev command')).toBeInTheDocument();
  });

  it('auto-detect fills empty command fields from the repo and expands the section', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    vi.mocked(api.detectCommands).mockResolvedValue({
      ...NO_COMMANDS,
      testCommand: 'pnpm run test',
      lintCommand: 'pnpm run lint',
    });
    renderProjects();
    await screen.findByText(/No projects yet/);

    await userEvent.click(screen.getByRole('button', { name: /New project/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Repo path *'), '/my/repo');
    await userEvent.click(within(dialog).getByRole('button', { name: /Auto-detect/ }));

    expect(api.detectCommands).toHaveBeenCalledWith('/my/repo');
    // The section auto-expands so the filled values are visible.
    expect(await within(dialog).findByLabelText('Test command')).toHaveValue('pnpm run test');
    expect(within(dialog).getByLabelText('Lint command')).toHaveValue('pnpm run lint');
  });

  it('auto-detect reports when nothing is found', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([]);
    vi.mocked(api.detectCommands).mockResolvedValue({ ...NO_COMMANDS });
    renderProjects();
    await screen.findByText(/No projects yet/);

    await userEvent.click(screen.getByRole('button', { name: /New project/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Repo path *'), '/my/repo');
    await userEvent.click(within(dialog).getByRole('button', { name: /Auto-detect/ }));

    expect(await within(dialog).findByText(/No commands found/)).toBeInTheDocument();
  });
});
