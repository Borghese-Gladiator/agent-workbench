import { useState } from 'react';
import { tasksApi, type TaskWorkflowState } from '../api/tasks.js';
import { PageHeader } from '../components/PageHeader.js';
import { Note } from '../components/Note.js';
import { ErrorText } from '../components/ErrorText.js';
import { TaskLookupForm } from '../components/TaskLookupForm.js';

export function EvidenceViewerPage() {
  const [state, setState] = useState<TaskWorkflowState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function handleLookup(repositoryId: string, taskId: string): Promise<void> {
    setBusy(true);
    try {
      const result = await tasksApi.getState(repositoryId, taskId);
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
    <div className="page">
      <PageHeader title="Evidence Viewer" />
      <Note>
        No daemon route exposes Evidence/artifact records yet (no read path into the `findings` /
        `evidence` SQLite tables). This page can only show the candidate evidence IDs already present
        on task state — it does not, and cannot yet, show video/trace playback or structured
        assertions.
      </Note>
      <TaskLookupForm busy={busy} onLookup={(r, t) => void handleLookup(r, t)} />
      {error && <ErrorText>{error}</ErrorText>}
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
