import { useEffect, useState } from 'react';
import { api, type Repository } from '../api/client.js';
import { Field } from './Field.js';
import { Button } from './Button.js';
import { RepositorySelect } from './RepositorySelect.js';

/**
 * Shared repository + task-id lookup form used by the Approvals and Evidence pages (neither has a
 * daemon route to list tasks, so the caller supplies both ids). The repository is chosen by name
 * via RepositorySelect — no UUID typing — while the task id remains a text field.
 */
export function TaskLookupForm({
  busy,
  onLookup,
}: {
  busy: boolean;
  onLookup: (repositoryId: string, taskId: string) => void;
}) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [taskId, setTaskId] = useState('');

  useEffect(() => {
    void api
      .listRepositories()
      .then(setRepositories)
      .catch(() => setRepositories([]));
  }, []);

  const valid = repositoryId.trim().length > 0 && taskId.trim().length > 0;

  return (
    <form
      className="lookup-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onLookup(repositoryId.trim(), taskId.trim());
      }}
    >
      <Field label="Repository">
        {(id) => (
          <RepositorySelect id={id} repositories={repositories} value={repositoryId} onChange={setRepositoryId} />
        )}
      </Field>
      <Field label="Task ID">
        {(id) => (
          <input id={id} type="text" placeholder="task id" value={taskId} onChange={(e) => setTaskId(e.target.value)} />
        )}
      </Field>
      <Button type="submit" variant="primary" disabled={busy || !valid}>
        Look up
      </Button>
    </form>
  );
}
