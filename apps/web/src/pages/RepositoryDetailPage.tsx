import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/layout/PageHeader';
import { statusPresentation } from '@/lib/task-status';
import { deriveTaskTitle, relativeTime } from '@/lib/format';
import { api, type RepositoryDetail } from '../api/client.js';
import { tasksApi } from '../api/tasks.js';

export function RepositoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<RepositoryDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  async function refresh(): Promise<void> {
    if (!id) return;
    try {
      setData(await api.getRepository(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, [id]);

  async function withBusy(fn: () => Promise<unknown>): Promise<void> {
    if (!id) return;
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(): Promise<void> {
    if (!id || !prompt.trim()) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const result = await tasksApi.create(id, prompt.trim());
      setCreateOpen(false);
      setPrompt('');
      navigate(`/tasks/${id}/${result.taskId}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  const back = { to: '/repositories', label: 'Repositories' };

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Repository" back={back} />
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        <PageHeader title="Repository" back={back} />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const { repository, latestSnapshot } = data;
  // Tolerate an older daemon that doesn't return these fields yet.
  const commands = data.commands ?? [];
  const tasks = data.tasks ?? [];

  return (
    <div>
      <PageHeader
        title={repository.name}
        back={back}
        actions={
          <>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Create task
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void withBusy(() => api.refreshRepository(id!))}>
              Refresh
            </Button>
            {!repository.trusted && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void withBusy(() => api.approveRepository(id!))}>
                Approve
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Default branch" value={repository.defaultBranch} />
        <StatTile label="Trust" value={repository.trusted ? 'trusted' : 'untrusted'} tone={repository.trusted ? 'ok' : 'warn'} />
        <StatTile label="Indexed head" value={latestSnapshot ? latestSnapshot.headSha.slice(0, 12) : '—'} />
        <StatTile label="Active tasks" value={tasks.length} />
      </div>

      <Panel className="mb-4">
        <PanelHeader title="Path" />
        <PanelBody>
          <code className="font-mono text-sm text-muted-foreground">{repository.canonicalPath}</code>
          {latestSnapshot && (
            <p className="mt-2 text-xs text-muted-foreground">
              Last indexed {relativeTime(latestSnapshot.createdAt)} at{' '}
              <code className="font-mono">{latestSnapshot.headSha.slice(0, 12)}</code>
            </p>
          )}
        </PanelBody>
      </Panel>

      <Panel className="mb-4">
        <PanelHeader title="Discovered commands" />
        {commands.length === 0 ? (
          <PanelBody className="text-sm text-muted-foreground">
            No commands discovered yet. Refresh to index the repository.
          </PanelBody>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Purpose</TableHead>
                <TableHead>Command</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {commands.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="text-sm capitalize text-foreground">{c.purpose}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{c.command}</TableCell>
                  <TableCell>
                    <Badge variant={c.status === 'validated' ? 'done' : 'outline'}>{c.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Tasks in this repository" />
        {tasks.length === 0 ? (
          <PanelBody className="text-sm text-muted-foreground">No tasks yet. Use Create task to start work here.</PanelBody>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => {
                const status = statusPresentation(t.derivedStatus);
                return (
                  <TableRow key={t.taskId} className="cursor-pointer" onClick={() => navigate(`/tasks/${t.repositoryId}/${t.taskId}`)}>
                    <TableCell className="text-sm font-medium text-foreground">{t.title ?? deriveTaskTitle(t.prompt)}</TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{relativeTime(t.updatedAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create task in {repository.name}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="repo-prompt">Task prompt</Label>
              <Textarea id="repo-prompt" rows={4} placeholder="Describe the task…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </div>
            {createError && <p className="text-sm text-danger">{createError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
              <Button onClick={() => void handleCreate()} disabled={creating || !prompt.trim()}>
                {creating ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
