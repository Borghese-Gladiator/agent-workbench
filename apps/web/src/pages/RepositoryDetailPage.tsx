import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui/panel';
import { PageHeader } from '@/components/layout/PageHeader';
import { api, type Repository, type RepositorySnapshotSummary } from '../api/client.js';

export function RepositoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [repository, setRepository] = useState<Repository | undefined>();
  const [snapshot, setSnapshot] = useState<RepositorySnapshotSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    if (!id) return;
    try {
      const result = await api.getRepository(id);
      setRepository(result.repository);
      setSnapshot(result.latestSnapshot);
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

  if (error && !repository) {
    return (
      <div>
        <PageHeader title="Repository" back={{ to: '/repositories', label: 'Repositories' }} />
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      </div>
    );
  }
  if (!repository) {
    return (
      <div>
        <PageHeader title="Repository" back={{ to: '/repositories', label: 'Repositories' }} />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={repository.name}
        back={{ to: '/repositories', label: 'Repositories' }}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void withBusy(() => api.refreshRepository(id!))}
            >
              Refresh
            </Button>
            {!repository.trusted && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void withBusy(() => api.approveRepository(id!))}
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

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Default branch" value={repository.defaultBranch} />
        <StatTile
          label="Trust"
          value={repository.trusted ? 'trusted' : 'untrusted'}
          tone={repository.trusted ? 'ok' : 'warn'}
        />
        <StatTile label="Indexed head" value={snapshot ? snapshot.headSha.slice(0, 12) : '—'} />
      </div>

      <Panel>
        <PanelHeader title="Path" />
        <PanelBody>
          <code className="font-mono text-sm text-muted-foreground">
            {repository.canonicalPath}
          </code>
        </PanelBody>
      </Panel>
    </div>
  );
}
