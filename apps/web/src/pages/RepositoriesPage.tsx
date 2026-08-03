import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Repository } from '../api/client.js';
import { PageHeader } from '../components/PageHeader.js';
import { Button } from '../components/Button.js';
import { ErrorText } from '../components/ErrorText.js';
import { Field } from '../components/Field.js';
import { StatusBadge } from '../components/Badge.js';

export function RepositoriesPage() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    try {
      const result = await api.listRepositories();
      setRepositories(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleAdd(): Promise<void> {
    if (!path.trim()) return;
    try {
      await api.addRepository(path.trim());
      setPath('');
      setError(undefined);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="page">
      <PageHeader title="Repositories" />
      <form
        className="add-repository-form"
        onSubmit={(e) => {
          e.preventDefault();
          void handleAdd();
        }}
      >
        <Field label="Repository path">
          {(id) => (
            <input
              id={id}
              type="text"
              placeholder="/path/to/repo"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary">
          Add repository
        </Button>
      </form>
      {error && <ErrorText>{error}</ErrorText>}
      {loading ? (
        <p>Loading…</p>
      ) : repositories.length === 0 ? (
        <p>No repositories registered yet.</p>
      ) : (
        <ul className="repository-list">
          {repositories.map((repo) => (
            <li key={repo.id}>
              <Link to={`/repositories/${repo.id}`}>{repo.name}</Link>
              {repo.trusted ? (
                <StatusBadge label="Trusted" tone="success" icon="✓" />
              ) : (
                <StatusBadge label="Untrusted" tone="attention" icon="!" />
              )}
              <span className="repository-path">{repo.canonicalPath}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
