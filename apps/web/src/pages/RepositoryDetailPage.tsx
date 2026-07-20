import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
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

  if (error) return <p className="error">{error}</p>;
  if (!repository) return <p>Loading…</p>;

  return (
    <div>
      <h1>{repository.name}</h1>
      <p>{repository.canonicalPath}</p>
      <p>Default branch: {repository.defaultBranch}</p>
      <p>Status: {repository.trusted ? 'trusted' : 'untrusted'}</p>
      {snapshot && (
        <p>
          Last indexed at <code>{snapshot.headSha.slice(0, 12)}</code>
        </p>
      )}
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void handleRefresh()}>
          Refresh
        </button>
        {!repository.trusted && (
          <button type="button" disabled={busy} onClick={() => void handleApprove()}>
            Approve
          </button>
        )}
      </div>
    </div>
  );
}
