import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/panel';
import { PageHeader } from '@/components/layout/PageHeader';
import { tasksApi, type TaskWorkflowState } from '../api/tasks.js';
import { GatePanel } from './GatePanel.js';

export function ApprovalsPage() {
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
      <PageHeader title="Approvals" />

      <div className="mb-5 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
        There is no daemon route yet that lists every pending gate across all tasks, so this is not
        a global aggregated view. Enter a repository id and task id to view and act on that
        task&apos;s pending gate.
      </div>

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

      {state &&
        (state.pendingHumanGate ? (
          <div className="mt-4">
            <GatePanel
              repositoryId={repositoryId.trim()}
              taskId={taskId.trim()}
              gate={state.pendingHumanGate}
              size={state.size}
              onDecided={() => void handleLookup()}
            />
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">No pending human gate for this task.</p>
        ))}
    </div>
  );
}
