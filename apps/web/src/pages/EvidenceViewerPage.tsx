import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/panel';
import { PageHeader } from '@/components/layout/PageHeader';
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
        tasksApi
          .listMedia(repositoryId.trim(), taskId.trim())
          .catch(() => [] as TaskMediaArtifact[]),
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
      <PageHeader title="Evidence" />

      <Panel>
        <PanelHeader title="Look up task" />
        <PanelBody className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="repository id"
            aria-label="Repository id"
            value={repositoryId}
            onChange={(e) => setRepositoryId(e.target.value)}
            className="w-64"
          />
          <Input
            placeholder="task id"
            aria-label="Task id"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            className="w-64"
          />
          <Button disabled={busy} onClick={() => void handleLookup()}>
            Look up
          </Button>
        </PanelBody>
      </Panel>

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {media.length > 0 && (
        <Panel className="mt-4">
          <PanelHeader title="QA media" />
          <PanelBody className="flex flex-col gap-4">
            {media.map((m) => (
              <MediaArtifact key={m.id} artifact={m} />
            ))}
          </PanelBody>
        </Panel>
      )}

      {state && (
        <Panel className="mt-4">
          <PanelHeader title="Candidate evidence" />
          <PanelBody>
            {state.latestCandidateEvidenceIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No candidate evidence recorded for this task yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
                {state.latestCandidateEvidenceIds.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            )}
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}

/** Renders one QA-media artifact inline: GIF/PNG via <img>, WEBM via <video>, trace as a download. */
function MediaArtifact({ artifact }: { artifact: TaskMediaArtifact }) {
  const url = artifactContentUrl(artifact.id);
  if (artifact.mediaType === 'video/webm') {
    return (
      <figure className="flex flex-col gap-1.5">
        <figcaption className="text-xs font-medium text-muted-foreground">
          {artifact.kind}
        </figcaption>
        <video controls src={url} className="max-w-full rounded-md border" />
      </figure>
    );
  }
  if (artifact.mediaType === 'image/gif' || artifact.mediaType.startsWith('image/')) {
    return (
      <figure className="flex flex-col gap-1.5">
        <figcaption className="text-xs font-medium text-muted-foreground">
          {artifact.kind}
        </figcaption>
        <img src={url} alt={artifact.kind} className="max-w-full rounded-md border" />
      </figure>
    );
  }
  return (
    <a href={url} download className="text-sm text-primary underline-offset-4 hover:underline">
      Download {artifact.kind} ({artifact.mediaType})
    </a>
  );
}
