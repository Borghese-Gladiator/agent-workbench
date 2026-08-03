import { useState } from 'react';
import { Modal } from './Modal.js';
import { Button } from './Button.js';
import { ErrorText } from './ErrorText.js';
import { RepositorySelect } from './RepositorySelect.js';
import type { Repository } from '../api/client.js';

export interface CreateTaskFormData {
  repositoryId: string;
  prompt: string;
}

/**
 * Task-creation dialog. The Create button stays disabled until both a repository and a non-empty
 * prompt are chosen. On submit it reports loading, then either closes (success) or surfaces the
 * error inline while preserving the entered values.
 */
export function CreateTaskModal({
  repositories,
  initial,
  onCancel,
  onSubmit,
}: {
  repositories: Repository[];
  initial?: CreateTaskFormData;
  onCancel: () => void;
  onSubmit: (data: CreateTaskFormData) => Promise<void>;
}) {
  const [repositoryId, setRepositoryId] = useState(initial?.repositoryId ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const valid = repositoryId.trim().length > 0 && prompt.trim().length > 0;

  async function handleSubmit(): Promise<void> {
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit({ repositoryId, prompt: prompt.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Create task" onClose={onCancel}>
      <form
        className="create-task-form"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="field">
          <label htmlFor="create-task-repo">Repository</label>
          <RepositorySelect
            id="create-task-repo"
            repositories={repositories}
            value={repositoryId}
            onChange={setRepositoryId}
          />
        </div>
        <div className="field">
          <label htmlFor="create-task-prompt">Task prompt</label>
          <textarea
            id="create-task-prompt"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        <div className="modal__actions">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
