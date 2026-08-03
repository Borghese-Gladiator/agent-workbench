import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { deriveTaskStatus, STATUS_FILTER_OPTIONS } from '@/lib/task-status';
import { relativeTime, shortId } from '@/lib/format';

/**
 * PROOF-OF-CONCEPT ONLY. This page renders STUB data (no daemon call) to demonstrate the Tasks
 * UI in the ported v4 shadcn/ui + Linear design system. It is NOT wired to `/api/tasks`. See the
 * draft PR description; a production version would fetch the real widened payload.
 */

/** Stub task shape mirroring the widened GET /api/tasks payload. */
interface TaskRow {
  taskId: string;
  repositoryId: string;
  repositoryName: string;
  prompt: string;
  phase: string;
  condition: string;
  createdAt: string;
}

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();

const STUB_TASKS: TaskRow[] = [
  { taskId: '77665544-3333-2222-1111-000000000000', repositoryId: 'repo-2', repositoryName: 'portal', prompt: 'Implement President card game with multiplayer lobby', phase: 'plan', condition: 'running', createdAt: iso(0.4) },
  { taskId: 'a1b2c3d4-eeee-ffff-0000-999988887777', repositoryId: 'repo-1', repositoryName: 'browser-games', prompt: 'Add portal footer with copyright and links', phase: 'implement', condition: 'running', createdAt: iso(4) },
  { taskId: 'ed33645f-aaaa-bbbb-cccc-111122223333', repositoryId: 'repo-1', repositoryName: 'browser-games', prompt: 'Add README game count so the repository landing page shows how many playable games are bundled', phase: 'assimilate', condition: 'completed', createdAt: iso(8) },
  { taskId: 'deadbeef-1234-5678-9abc-def012345678', repositoryId: 'repo-2', repositoryName: 'portal', prompt: 'Fix login redirect loop', phase: 'verify', condition: 'awaiting-human', createdAt: iso(62) },
];

const REPOS = [
  { id: 'repo-1', name: 'browser-games' },
  { id: 'repo-2', name: 'portal' },
];

export function TasksPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [repoFilter, setRepoFilter] = useState('All');
  const [sort, setSort] = useState('newest');
  const [createOpen, setCreateOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = STUB_TASKS.filter((t) => {
      const status = deriveTaskStatus(t.condition, t.phase);
      if (statusFilter !== 'All' && status.label !== statusFilter) return false;
      if (repoFilter !== 'All' && t.repositoryId !== repoFilter) return false;
      if (q && ![t.prompt, t.taskId, t.repositoryName].join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
    rows.sort((a, b) => (sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)));
    return rows;
  }, [search, statusFilter, repoFilter, sort]);

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
          {REPOS.map((r) => (
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
        <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create task
        </Button>
      </div>

      <div className="mb-5 flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
        <span aria-hidden className="text-primary">
          ⓘ
        </span>
        Tasks shown here are stored by the daemon and reappear after a restart.
      </div>

      <Panel className="flex flex-col">
        <PanelHeader title="Pipeline" action={controls} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((task) => {
              const status = deriveTaskStatus(task.condition, task.phase);
              return (
                <TableRow key={task.taskId}>
                  <TableCell className="max-w-md align-top">
                    <div className="font-mono text-xs text-primary">{shortId(task.taskId)}</div>
                    <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-foreground">
                      {task.prompt}
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-sm">{task.repositoryName}</TableCell>
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
        {filtered.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">No tasks match the current filters.</p>
        )}
      </Panel>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create task</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="repo">Repository</Label>
              <Select>
                <SelectTrigger id="repo">
                  <SelectValue placeholder="Select a repository" />
                </SelectTrigger>
                <SelectContent>
                  {REPOS.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prompt">Task prompt</Label>
              <Textarea id="prompt" rows={4} placeholder="Describe the task…" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button>Create</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
