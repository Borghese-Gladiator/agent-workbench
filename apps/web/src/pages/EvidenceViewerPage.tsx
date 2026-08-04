import { useState } from 'react';
import {
  tasksApi,
  artifactContentUrl,
  type TaskWorkflowState,
  type TaskMediaArtifact,
} from '../api/tasks.js';

export function EvidenceViewerPage() {
  const [repositoryId, setRepositoryId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [state, setState] = useState<TaskWorkflowState | undefined>();
  const [media, setMedia] = useState<TaskMediaArtifact[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function handleLookup(): Promise<void> {
    if (!repositoryId.trim() || !taskId.trim()) return;
    setBusy(true);
    try {
      const [result, mediaResult] = await Promise.all([
        tasksApi.getState(repositoryId.trim(), taskId.trim()),
        tasksApi.listMedia(repositoryId.trim(), taskId.trim()).catch(() => [] as TaskMediaArtifact[]),
      ]);
      setState(result.state);
      setMedia(mediaResult);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState(undefined);
      setMedia([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Evidence Viewer</h1>
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

      {media.length > 0 && (
        <section>
          <h2>QA media</h2>
          {media.map((m) => (
            <MediaArtifact key={m.id} artifact={m} />
          ))}
        </section>
      )}

      {state && (
        <section>
          <h2>Candidate evidence</h2>
          {state.latestCandidateEvidenceIds.length === 0 ? (
            <p>No candidate evidence recorded for this task yet.</p>
          ) : (
            <ul>
              {state.latestCandidateEvidenceIds.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/** Renders one QA-media artifact inline: GIF/PNG via <img>, WEBM via <video>, trace as a download. */
function MediaArtifact({ artifact }: { artifact: TaskMediaArtifact }) {
  const url = artifactContentUrl(artifact.id);
  if (artifact.mediaType === 'video/webm') {
    return (
      <figure>
        <figcaption>{artifact.kind}</figcaption>
        <video controls src={url} style={{ maxWidth: '100%' }} />
      </figure>
    );
  }
  if (artifact.mediaType === 'image/gif' || artifact.mediaType.startsWith('image/')) {
    return (
      <figure>
        <figcaption>{artifact.kind}</figcaption>
        <img src={url} alt={artifact.kind} style={{ maxWidth: '100%' }} />
      </figure>
    );
  }
  return (
    <p>
      <a href={url} download>
        Download {artifact.kind} ({artifact.mediaType})
      </a>
    </p>
  );
}
