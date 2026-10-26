import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelHeader } from '@/components/ui/panel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PageHeader } from '@/components/layout/PageHeader';
import { api, type Repository } from '../api/client.js';

export function RepositoriesPage() {
  const navigate = useNavigate();
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

  const addForm = (
    <div className="flex items-center gap-2">
      <Input
        placeholder="/path/to/repo"
        aria-label="Repository path"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleAdd();
        }}
        className="h-8 w-64"
      />
      <Button size="sm" onClick={() => void handleAdd()} disabled={!path.trim()}>
        Add repository
      </Button>
    </div>
  );

  return (
    <div>
      <PageHeader title="Repositories" />

      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <Panel>
        <PanelHeader title="Registry" action={addForm} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Repository</TableHead>
              <TableHead>Path</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Trust</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {repositories.map((repo) => (
              <TableRow
                key={repo.id}
                className="cursor-pointer"
                onClick={() => navigate(`/repositories/${repo.id}`)}
              >
                <TableCell className="font-medium text-foreground">{repo.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {repo.canonicalPath}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {repo.defaultBranch}
                </TableCell>
                <TableCell>
                  <Badge variant={repo.trusted ? 'done' : 'outline'}>
                    {repo.trusted ? 'trusted' : 'untrusted'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {loading ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : repositories.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No repositories registered yet. Add one above to get started.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
