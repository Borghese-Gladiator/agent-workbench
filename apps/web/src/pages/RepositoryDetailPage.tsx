import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui/panel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PageHeader } from '@/components/layout/PageHeader';
import { statusPresentation } from '@/lib/task-status';
import { deriveTaskTitle, formatTokens, relativeTime, shortId } from '@/lib/format';
import { api, type RepositoryDetail } from '../api/client.js';

type Tab = 'overview' | 'tasks' | 'commands' | 'policies' | 'activity';

export function RepositoryDetailPage() {
  const navigate = useNavigate();
  const { repositoryId } = useParams<{ repositoryId: string }>();
  const [detail, setDetail] = useState<RepositoryDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');

  async function refresh(): Promise<void> {
    if (!repositoryId) return;
    try {
      setDetail(await api.getRepository(repositoryId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, [repositoryId]);

  async function withBusy(fn: () => Promise<unknown>): Promise<void> {
    if (!repositoryId) return;
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

  const back = { to: '/repositories', label: 'Repositories' };

  if (error && !detail) {
    return (
      <div>
        <PageHeader title="Repository" back={back} />
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      </div>
    );
  }
  if (!detail || !repositoryId) {
    return (
      <div>
        <PageHeader title="Repository" back={back} />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const { repository, latestSnapshot, commands, tasks, scopedTokenUsage } = detail;

  return (
    <div>
      <PageHeader
        title={repository.name}
        back={back}
        actions={
          <>
            <Button
              size="sm"
              onClick={() =>
                navigate('/tasks', { state: { repositoryId } })
              }
            >
              Create task
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void withBusy(() => api.refreshRepository(repositoryId))}
            >
              Sync
            </Button>
            {!repository.trusted && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void withBusy(() => api.approveRepository(repositoryId))}
              >
                Approve
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Trust"
          value={repository.trusted ? 'trusted' : 'untrusted'}
          tone={repository.trusted ? 'ok' : 'warn'}
        />
        <StatTile label="Default branch" value={repository.defaultBranch} />
        <StatTile label="Origin" value={repository.remoteUrl ? shortId(repository.remoteUrl) : '—'} />
        <StatTile label="Last sync" value={latestSnapshot ? relativeTime(latestSnapshot.createdAt) : '—'} />
        <StatTile label="Indexed head" value={latestSnapshot ? latestSnapshot.headSha.slice(0, 12) : '—'} />
      </div>

      <div className="mb-4 flex gap-1 border-b">
        {(
          [
            ['overview', 'Overview'],
            ['tasks', `Tasks (${tasks.length})`],
            ['commands', `Commands & environment (${commands.length})`],
            ['policies', 'Policies'],
            ['activity', 'Activity'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={
              tab === id
                ? '-mb-px border-b-2 border-primary px-3 py-1.5 text-sm font-medium text-foreground'
                : '-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader title="Path" />
            <PanelBody>
              <code className="font-mono text-sm text-muted-foreground">{repository.canonicalPath}</code>
            </PanelBody>
          </Panel>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile label="Input tokens" value={formatTokens(scopedTokenUsage.inputTokens)} />
            <StatTile label="Output tokens" value={formatTokens(scopedTokenUsage.outputTokens)} />
            <StatTile
              label="Cost"
              value={scopedTokenUsage.costUsd != null ? `$${scopedTokenUsage.costUsd.toFixed(2)}` : '—'}
            />
          </div>
        </div>
      )}

      {tab === 'tasks' && (
        <Panel>
          <PanelHeader title="Tasks" />
          {tasks.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No tasks in this repository yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => {
                  const status = statusPresentation(task.derivedStatus);
                  return (
                    <TableRow
                      key={task.taskId}
                      className="cursor-pointer"
                      onClick={() => navigate(`/tasks/${task.repositoryId}/${task.taskId}`)}
                    >
                      <TableCell className="text-sm font-medium text-foreground">
                        {task.title ?? deriveTaskTitle(task.prompt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={status.badgeVariant}>{status.label}</Badge>
                      </TableCell>
                      <TableCell className="text-sm capitalize text-muted-foreground">{task.phase}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {relativeTime(task.updatedAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      )}

      {tab === 'commands' && (
        <Panel>
          <PanelHeader title="Commands & environment" />
          {commands.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No commands discovered for this repository yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Command</TableHead>
                  <TableHead>Working dir</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commands.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-sm text-muted-foreground">{c.purpose}</TableCell>
                    <TableCell className="font-mono text-xs text-foreground">{c.command}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{c.cwd}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{c.source}</TableCell>
                    <TableCell>
                      <Badge variant={c.status === 'validated' ? 'done' : 'outline'}>{c.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      )}

      {tab === 'policies' && (
        <Panel>
          <PanelHeader title="Policies" />
          <PanelBody className="text-sm text-muted-foreground">
            Trust: <span className="text-foreground">{repository.trusted ? 'trusted' : 'untrusted'}</span>.
            An untrusted repository is forced to draft-PR delivery with deeper self-review. There is no
            write route to edit policies from the browser yet.
          </PanelBody>
        </Panel>
      )}

      {tab === 'activity' && (
        <Panel>
          <PanelHeader title="Activity" />
          <PanelBody>
            {tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent activity.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {[...tasks]
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .slice(0, 20)
                  .map((task) => (
                    <li key={task.taskId} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-foreground">
                        {task.title ?? deriveTaskTitle(task.prompt)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {statusPresentation(task.derivedStatus).label} · {relativeTime(task.updatedAt)}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}
