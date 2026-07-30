import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { tasksApi, type TaskSummary } from '../api/tasks.js';
import { api, type Repository } from '../api/client.js';
import { deriveTaskStatus, STATUS_FILTER_OPTIONS } from '../lib/task-status.js';
import { shortId } from '../lib/format.js';
import { StatusBadge } from '../components/Badge.js';
import { CopyButton } from '../components/CopyButton.js';
import { RelativeTime } from '../components/RelativeTime.js';
import { DropdownMenu, type MenuItem } from '../components/DropdownMenu.js';
import { InfoNotice } from '../components/InfoNotice.js';
import { SkeletonRows } from '../components/SkeletonRows.js';
import { CreateTaskModal, type CreateTaskFormData } from '../components/CreateTaskModal.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { useToast } from '../components/Toast.js';

const POLL_INTERVAL_MS = 4000;
type SortOption = 'newest' | 'oldest' | 'updated';

interface PendingConfirm {
  kind: 'cancel' | 'delete';
  task: TaskSummary;
}

export function TasksPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState<CreateTaskFormData | undefined>();
  const [confirm, setConfirm] = useState<PendingConfirm | undefined>();
  const [highlightId, setHighlightId] = useState<string | undefined>();
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>();

  const search = searchParams.get('q') ?? '';
  const statusFilter = searchParams.get('status') ?? 'All';
  const repoFilter = searchParams.get('repo') ?? 'All';
  const sort = (searchParams.get('sort') as SortOption) ?? 'newest';

  function patchParams(next: Record<string, string>): void {
    const merged = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(next)) {
      if (!v || v === 'All' || (k === 'sort' && v === 'newest') || (k === 'q' && v === '')) merged.delete(k);
      else merged.set(k, v);
    }
    setSearchParams(merged, { replace: true });
  }

  async function refresh(): Promise<void> {
    try {
      const result = await tasksApi.list();
      setTasks(result);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    void api
      .listRepositories()
      .then(setRepositories)
      .catch(() => setRepositories([]));
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(highlightTimer.current);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = tasks.filter((t) => {
      const status = deriveTaskStatus(t.condition, t.phase);
      if (statusFilter !== 'All' && status.label !== statusFilter) return false;
      if (repoFilter !== 'All' && t.repositoryId !== repoFilter) return false;
      if (q) {
        const haystack = [t.prompt, t.taskId, t.repositoryName ?? '', t.repositoryId].join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    rows.sort((a, b) => {
      if (sort === 'oldest') return a.createdAt.localeCompare(b.createdAt);
      if (sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
      return b.createdAt.localeCompare(a.createdAt);
    });
    return rows;
  }, [tasks, search, statusFilter, repoFilter, sort]);

  const filtersActive = search !== '' || statusFilter !== 'All' || repoFilter !== 'All';

  async function handleCreate(data: CreateTaskFormData): Promise<void> {
    const result = await tasksApi.create(data.repositoryId, data.prompt);
    setShowCreate(false);
    setDraft(undefined);
    setHighlightId(result.taskId);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(undefined), 4000);
    toast.show('Task created', 'success');
    await refresh();
  }

  async function runConfirm(): Promise<void> {
    if (!confirm) return;
    const { kind, task } = confirm;
    setConfirm(undefined);
    try {
      if (kind === 'cancel') {
        await tasksApi.cancel(task.repositoryId, task.taskId);
        toast.show('Task cancelled', 'info');
      } else {
        await tasksApi.remove(task.repositoryId, task.taskId);
        toast.show('Task deleted', 'info');
      }
      await refresh();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  function rowActions(task: TaskSummary): MenuItem[] {
    const status = deriveTaskStatus(task.condition, task.phase);
    const terminal = ['Completed', 'Failed', 'Cancelled'].includes(status.label);
    const items: MenuItem[] = [
      { label: 'View details', onSelect: () => navigate(`/tasks/${task.repositoryId}/${task.taskId}`) },
      { label: 'Copy task ID', onSelect: () => void copyId(task.taskId) },
      { label: 'Open repository', onSelect: () => navigate(`/repositories/${task.repositoryId}`) },
    ];
    if (!terminal) items.push({ label: 'Cancel task', danger: true, onSelect: () => setConfirm({ kind: 'cancel', task }) });
    items.push({ label: 'Delete task', danger: true, onSelect: () => setConfirm({ kind: 'delete', task }) });
    return items;
  }

  async function copyId(value: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(value);
      toast.show('Copied', 'success');
    } catch {
      toast.show('Copy failed', 'error');
    }
  }

  return (
    <div className="page">
      <header className="page__header">
        <h1>Tasks</h1>
        <button type="button" className="button button--primary" onClick={() => setShowCreate(true)}>
          Create task
        </button>
      </header>

      <InfoNotice learnMoreHref="https://github.com/timothysheee/agent-workbench/blob/main/docs/README.md">
        Tasks shown here are stored by the daemon and reappear after a restart.
      </InfoNotice>

      <div className="controls">
        <input
          type="search"
          className="controls__search"
          placeholder="Search tasks…"
          aria-label="Search tasks by prompt, task ID, or repository"
          value={search}
          onChange={(e) => patchParams({ q: e.target.value })}
        />
        <label className="controls__field">
          <span className="controls__label">Status</span>
          <select value={statusFilter} onChange={(e) => patchParams({ status: e.target.value })}>
            {STATUS_FILTER_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="controls__field">
          <span className="controls__label">Repository</span>
          <select value={repoFilter} onChange={(e) => patchParams({ repo: e.target.value })}>
            <option value="All">All</option>
            {repositories.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="controls__field">
          <span className="controls__label">Sort</span>
          <select value={sort} onChange={(e) => patchParams({ sort: e.target.value })}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="updated">Last updated</option>
          </select>
        </label>
      </div>

      {error && !loading ? (
        <div className="state-panel state-panel--error" role="alert">
          <p>Tasks could not be loaded. {error}</p>
          <button type="button" className="button button--secondary" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : (
        <table className="task-table">
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col" className="col-repo">
                Repository
              </th>
              <th scope="col">Status</th>
              <th scope="col" className="col-created">
                Created
              </th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows />
          ) : (
            <tbody>
              {filtered.map((task) => {
                const status = deriveTaskStatus(task.condition, task.phase);
                return (
                  <tr key={task.workflowId} className={task.taskId === highlightId ? 'row--new' : undefined}>
                    <td className="cell-task">
                      <button
                        type="button"
                        className="task-id-link"
                        onClick={() => navigate(`/tasks/${task.repositoryId}/${task.taskId}`)}
                        title={task.taskId}
                      >
                        {shortId(task.taskId)}
                      </button>
                      <CopyButton value={task.taskId} label="Copy full task ID" />
                      <p className="task-prompt">{task.prompt}</p>
                      <span className="cell-repo-inline">{task.repositoryName ?? shortId(task.repositoryId)}</span>
                    </td>
                    <td className="col-repo">
                      <span className="repo-name" title={task.repositoryId}>
                        {task.repositoryName ?? shortId(task.repositoryId)}
                      </span>
                    </td>
                    <td>
                      <StatusBadge label={status.label} tone={status.tone} icon={status.icon} />
                    </td>
                    <td className="col-created">
                      <RelativeTime iso={task.createdAt} />
                    </td>
                    <td className="cell-actions">
                      <DropdownMenu label={`Actions for task ${shortId(task.taskId)}`} items={rowActions(task)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="state-panel">
          {filtersActive ? (
            <>
              <p>No tasks match the current filters.</p>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
              >
                Clear filters
              </button>
            </>
          ) : (
            <>
              <p>No tasks yet. Create a task to start work in one of your repositories.</p>
              <button type="button" className="button button--primary" onClick={() => setShowCreate(true)}>
                Create task
              </button>
            </>
          )}
        </div>
      )}

      {showCreate && (
        <CreateTaskModal
          repositories={repositories}
          initial={draft}
          onCancel={() => {
            setShowCreate(false);
            setDraft(undefined);
          }}
          onSubmit={handleCreate}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'cancel' ? 'Cancel task?' : 'Delete task?'}
          message={
            confirm.kind === 'cancel'
              ? 'This signals the workflow to stop. This cannot be undone.'
              : 'This permanently removes the task and all of its records. This cannot be undone.'
          }
          confirmLabel={confirm.kind === 'cancel' ? 'Cancel task' : 'Delete task'}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(undefined)}
        />
      )}
    </div>
  );
}
