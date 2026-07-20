import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Repository } from '../api/client.js';

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
    <div>
      <h1>Repositories</h1>
      <div className="add-repository-form">
        <input
          type="text"
          placeholder="/path/to/repo"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button type="button" onClick={() => void handleAdd()}>
          Add repository
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : repositories.length === 0 ? (
        <p>No repositories registered yet.</p>
      ) : (
        <ul className="repository-list">
          {repositories.map((repo) => (
            <li key={repo.id}>
              <Link to={`/repositories/${repo.id}`}>{repo.name}</Link>
              <span className={repo.trusted ? 'badge trusted' : 'badge untrusted'}>
                {repo.trusted ? 'trusted' : 'untrusted'}
              </span>
              <span className="repository-path">{repo.canonicalPath}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
