import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Repository, type RepositorySnapshotSummary } from '../api/client.js';
import { PageHeader } from '../components/PageHeader.js';
import { Button } from '../components/Button.js';
import { ErrorText } from '../components/ErrorText.js';
import { StatusBadge } from '../components/Badge.js';

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

  async function handleRefresh(): Promise<void> {
    if (!id) return;
    setBusy(true);
    try {
      await api.refreshRepository(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove(): Promise<void> {
    if (!id) return;
    setBusy(true);
    try {
      await api.approveRepository(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!repository) return <p>Loading…</p>;

  return (
    <div className="page">
      <PageHeader
        title={repository.name}
        action={
          repository.trusted ? (
            <StatusBadge label="Trusted" tone="success" icon="✓" />
          ) : (
            <StatusBadge label="Untrusted" tone="attention" icon="!" />
          )
        }
      />
      <p className="repository-path">{repository.canonicalPath}</p>
      <p>Default branch: {repository.defaultBranch}</p>
      {snapshot && (
        <p>
          Last indexed at <code>{snapshot.headSha.slice(0, 12)}</code>
        </p>
      )}
      <div className="actions">
        <Button variant="secondary" disabled={busy} onClick={() => void handleRefresh()}>
          Refresh
        </Button>
        {!repository.trusted && (
          <Button variant="primary" disabled={busy} onClick={() => void handleApprove()}>
            Approve
          </Button>
        )}
      </div>
    </div>
  );
}
