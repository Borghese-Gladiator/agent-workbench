import { useState } from 'react';
import { tasksApi, type TaskWorkflowState } from '../api/tasks.js';

export function EvidenceViewerPage() {
  const [repositoryId, setRepositoryId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [state, setState] = useState<TaskWorkflowState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function handleLookup(): Promise<void> {
    if (!repositoryId.trim() || !taskId.trim()) return;
    setBusy(true);
    try {
      const result = await tasksApi.getState(repositoryId.trim(), taskId.trim());
      setState(result.state);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState(undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Evidence Viewer</h1>
      <p className="note">
        No daemon route exposes Evidence/artifact records yet (no read path into the `findings` /
        `evidence` SQLite tables). This page can only show the candidate evidence IDs already
        present on task state — it does not, and cannot yet, show video/trace playback or
        structured assertions.
      </p>
      <div className="form-row">
        <input
          type="text"
          placeholder="repository id"
          value={repositoryId}
          onChange={(e) => setRepositoryId(e.target.value)}
        />
        <input type="text" placeholder="task id" value={taskId} onChange={(e) => setTaskId(e.target.value)} />
        <button type="button" disabled={busy} onClick={() => void handleLookup()}>
          Look up
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {state &&
        (state.latestCandidateEvidenceIds.length === 0 ? (
          <p>No candidate evidence recorded for this task yet.</p>
        ) : (
          <ul>
            {state.latestCandidateEvidenceIds.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        ))}
    </div>
  );
}
