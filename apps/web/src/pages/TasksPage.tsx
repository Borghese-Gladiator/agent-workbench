import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Panel, PanelHeader } from '@/components/ui/panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { statusPresentation, STATUS_FILTER_OPTIONS } from '@/lib/task-status';
import { deriveTaskTitle, relativeTime, shortId } from '@/lib/format';
import { api, type Repository } from '../api/client.js';
import { tasksApi, type TaskSummary } from '../api/tasks.js';
import { useTaskListLiveRefresh } from '../hooks/useTaskListLiveRefresh.js';
import { TaskBoard } from './TaskBoard.js';

const POLL_INTERVAL_MS = 4000;

export function TasksPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === 'board' ? 'board' : 'list';
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [repoFilter, setRepoFilter] = useState('All');
  const [sort, setSort] = useState('newest');

  const [createOpen, setCreateOpen] = useState(false);
  const [newRepoId, setNewRepoId] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await tasksApi.list();
      setTasks(result);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api
      .listRepositories()
      .then(setRepositories)
      .catch(() => setRepositories([]));
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Live status: refresh the list when the event stream reports activity, so rows advance without a
  // manual refresh. The poll above stays as a fallback if the socket is down.
  useTaskListLiveRefresh(() => void refresh());

  const repoLabel = (task: TaskSummary) => task.repositoryName ?? shortId(task.repositoryId);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = tasks.filter((t) => {
      const status = statusPresentation(t.derivedStatus);
      if (statusFilter !== 'All' && status.label !== statusFilter) return false;
      if (repoFilter !== 'All' && t.repositoryId !== repoFilter) return false;
      if (q && ![t.title ?? '', t.prompt, t.taskId, repoLabel(t)].join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
    rows.sort((a, b) =>
      sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt),
    );
    return rows;
  }, [tasks, search, statusFilter, repoFilter, sort]);

  const filtersActive = search !== '' || statusFilter !== 'All' || repoFilter !== 'All';

  // Compact "needs attention" counts over ALL tasks (not the filtered set) — the at-a-glance strip.
  const attention = useMemo(() => {
    let awaiting = 0;
    let failed = 0;
    let running = 0;
    for (const t of tasks) {
      if (t.derivedStatus === 'awaiting-human') awaiting += 1;
      else if (t.derivedStatus === 'failed' || t.derivedStatus === 'blocked') failed += 1;
      else if (t.derivedStatus === 'running' || t.derivedStatus === 'planning') running += 1;
    }
    return { awaiting, failed, running };
  }, [tasks]);

  async function handleCreate(): Promise<void> {
    if (!newRepoId || !newPrompt.trim()) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const result = await tasksApi.create(newRepoId, newPrompt.trim());
      setCreateOpen(false);
      setNewPrompt('');
      setNewRepoId('');
      navigate(`/tasks/${newRepoId}/${result.taskId}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  const controls = (
    <div className="flex items-center gap-2">
      <Input
        placeholder="Search tasks…"
        aria-label="Search tasks"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-8 w-56"
      />
      <Select value={statusFilter} onValueChange={setStatusFilter}>
        <SelectTrigger className="h-8 w-40" aria-label="Filter by status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_FILTER_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={repoFilter} onValueChange={setRepoFilter}>
        <SelectTrigger className="h-8 w-40" aria-label="Filter by repository">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="All">All repositories</SelectItem>
          {repositories.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={sort} onValueChange={setSort}>
        <SelectTrigger className="h-8 w-36" aria-label="Sort order">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="newest">Newest first</SelectItem>
          <SelectItem value="oldest">Oldest first</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>
          <div className="flex rounded-md border p-0.5" role="tablist" aria-label="View">
            {(['list', 'board'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setSearchParams((p) => (v === 'list' ? p.delete('view') : p.set('view', v), p), { replace: true })}
                className={
                  'rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors ' +
                  (view === v ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')
                }
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create task
        </Button>
      </div>

      {!loading && tasks.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-card px-3 py-2 text-sm">
          <span className="text-warn">{attention.awaiting} awaiting approval</span>
          <span aria-hidden className="text-muted-foreground">·</span>
          <span className="text-danger">{attention.failed} blocked / failed</span>
          <span aria-hidden className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{attention.running} running</span>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center justify-between rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <span>Tasks could not be loaded. {error}</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}

      {view === 'board' ? (
        <div className="flex flex-col gap-3">
          <div className="flex justify-end">{controls}</div>
          {loading ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : (
            <TaskBoard tasks={filtered} repoLabel={repoLabel} />
          )}
        </div>
      ) : (
      <Panel className="flex flex-col">
        <PanelHeader title="Pipeline" action={controls} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((task) => {
              const status = statusPresentation(task.derivedStatus);
              const title = task.title ?? deriveTaskTitle(task.prompt);
              return (
                <TableRow
                  key={task.workflowId}
                  className="cursor-pointer"
                  onClick={() => navigate(`/tasks/${task.repositoryId}/${task.taskId}`)}
                >
                  <TableCell className="max-w-md align-top">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-primary">{shortId(task.taskId)}</span>
                      {task.retryOfTaskId && (
                        <Badge variant="outline" className="text-[10px]">
                          retry
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 text-sm font-medium leading-snug text-foreground">{title}</div>
                    <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{task.prompt}</div>
                  </TableCell>
                  <TableCell className="align-top text-sm">{repoLabel(task)}</TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">{task.size ?? '—'}</TableCell>
                  <TableCell className="align-top">
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {relativeTime(task.createdAt)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {!loading && filtered.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {tasks.length === 0
              ? 'No tasks yet. Use Create task to start work in one of your repositories.'
              : filtersActive
                ? 'No tasks match the current filters.'
                : 'No tasks yet.'}
          </p>
        )}
        {loading && <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>}
      </Panel>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create task</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="repo">Repository</Label>
              <Select value={newRepoId} onValueChange={setNewRepoId}>
                <SelectTrigger id="repo">
                  <SelectValue placeholder="Select a repository" />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prompt">Task prompt</Label>
              <Textarea
                id="prompt"
                rows={4}
                placeholder="Describe the task…"
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
              />
            </div>
            {createError && <p className="text-sm text-danger">{createError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
              <Button onClick={() => void handleCreate()} disabled={creating || !newRepoId || !newPrompt.trim()}>
                {creating ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
