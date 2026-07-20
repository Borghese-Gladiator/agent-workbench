import { useState } from 'react';
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

  async function withBusy(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await fn();
      await handleLookup();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Human Approvals</h1>
      <p className="note">
        There is no daemon route yet that lists every pending gate across all tasks, so this is not
        a global aggregated view. Enter a specific repository id and task id to view and act on that
        task&apos;s pending gate.
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
        (state.pendingHumanGate ? (
          <GatePanel
            repositoryId={repositoryId.trim()}
            taskId={taskId.trim()}
            phase={state.phase}
            gate={state.pendingHumanGate}
            busy={busy}
            onApproveContract={() =>
              void withBusy(() =>
                tasksApi.approveContract(repositoryId.trim(), taskId.trim(), state.attemptNumber || 1),
              )
            }
            onRejectContract={() =>
              void withBusy(() => tasksApi.rejectContract(repositoryId.trim(), taskId.trim(), 'rejected from UI'))
            }
            onApprovePlan={() =>
              void withBusy(() => tasksApi.approvePlan(repositoryId.trim(), taskId.trim(), state.attemptNumber || 1))
            }
            onRejectPlan={() =>
              void withBusy(() => tasksApi.rejectPlan(repositoryId.trim(), taskId.trim(), 'rejected from UI'))
            }
          />
        ) : (
          <p>No pending human gate for this task.</p>
        ))}
    </div>
  );
}
