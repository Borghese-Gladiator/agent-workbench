import type { TaskWorkflowState } from '../api/tasks.js';

interface GatePanelProps {
  repositoryId: string;
  taskId: string;
  phase: TaskWorkflowState['phase'];
  gate: NonNullable<TaskWorkflowState['pendingHumanGate']>;
  busy: boolean;
  onApproveContract: () => void;
  onRejectContract: () => void;
  onApprovePlan: () => void;
  onRejectPlan: () => void;
}

/**
 * Renders a pending human gate and the best-available action for it. Only
 * `task-contract-approval` maps cleanly to a dedicated daemon route
 * (approve-contract/reject-contract). `pr-readiness` is a release-phase gate with no dedicated
 * daemon route yet, so it is display-only. For any other reason encountered while the task is in
 * the `plan` phase, the plan approve/reject routes are offered as the closest available action —
 * this is a best-effort mapping given current daemon capability, not a guarantee every reason is
 * correctly handled.
 */
export function GatePanel({
  phase,
  gate,
  busy,
  onApproveContract,
  onRejectContract,
  onApprovePlan,
  onRejectPlan,
}: GatePanelProps) {
  return (
    <div className="gate-panel">
      <h3>Pending human gate</h3>
      <p>
        <strong>Reason:</strong> {gate.reason}
      </p>
      <p>
        <strong>Phase:</strong> {gate.phase}
      </p>
      <p>{gate.summary}</p>
      <p className="repository-path">Created at {gate.createdAt}</p>
      {gate.reason === 'task-contract-approval' ? (
        <div className="actions">
          <button type="button" disabled={busy} onClick={onApproveContract}>
            Approve contract
          </button>
          <button type="button" disabled={busy} onClick={onRejectContract}>
            Reject contract
          </button>
        </div>
      ) : gate.reason === 'pr-readiness' ? (
        <p className="note">
          This is a release-phase gate (pr-readiness). No dedicated daemon route exists for it yet,
          so no action is available here — display only.
        </p>
      ) : phase === 'plan' ? (
        <div className="actions">
          <button type="button" disabled={busy} onClick={onApprovePlan}>
            Approve plan
          </button>
          <button type="button" disabled={busy} onClick={onRejectPlan}>
            Reject plan
          </button>
        </div>
      ) : (
        <p className="note">
          No dedicated daemon action is wired up for gate reason &quot;{gate.reason}&quot; — display
          only.
        </p>
      )}
    </div>
  );
}
