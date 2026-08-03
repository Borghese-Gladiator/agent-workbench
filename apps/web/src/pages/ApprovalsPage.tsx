import { useState } from 'react';
import { tasksApi, type TaskWorkflowState } from '../api/tasks.js';
import { GatePanel } from './GatePanel.js';
import { PageHeader } from '../components/PageHeader.js';
import { Note } from '../components/Note.js';
import { ErrorText } from '../components/ErrorText.js';
import { TaskLookupForm } from '../components/TaskLookupForm.js';

export function ApprovalsPage() {
  const [lookup, setLookup] = useState<{ repositoryId: string; taskId: string } | undefined>();
  const [state, setState] = useState<TaskWorkflowState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function handleLookup(repositoryId: string, taskId: string): Promise<void> {
    setLookup({ repositoryId, taskId });
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

  async function withBusy(fn: () => Promise<unknown>): Promise<void> {
    if (!lookup) return;
    setBusy(true);
    try {
      await fn();
      await handleLookup(lookup.repositoryId, lookup.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader title="Human Approvals" />
      <Note>
        There is no daemon route yet that lists every pending gate across all tasks, so this is not a
        global aggregated view. Choose a repository and enter a task id to view and act on that
        task&apos;s pending gate.
      </Note>
      <TaskLookupForm busy={busy} onLookup={(r, t) => void handleLookup(r, t)} />
      {error && <ErrorText>{error}</ErrorText>}
      {state &&
        lookup &&
        (state.pendingHumanGate ? (
          <GatePanel
            repositoryId={lookup.repositoryId}
            taskId={lookup.taskId}
            phase={state.phase}
            gate={state.pendingHumanGate}
            busy={busy}
            onApproveContract={() =>
              void withBusy(() => tasksApi.approveContract(lookup.repositoryId, lookup.taskId, state.attemptNumber || 1))
            }
            onRejectContract={() =>
              void withBusy(() => tasksApi.rejectContract(lookup.repositoryId, lookup.taskId, 'rejected from UI'))
            }
            onApprovePlan={() =>
              void withBusy(() => tasksApi.approvePlan(lookup.repositoryId, lookup.taskId, state.attemptNumber || 1))
            }
            onRejectPlan={() =>
              void withBusy(() => tasksApi.rejectPlan(lookup.repositoryId, lookup.taskId, 'rejected from UI'))
            }
          />
        ) : (
          <p>No pending human gate for this task.</p>
        ))}
    </div>
  );
}
