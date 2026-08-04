import { useState } from 'react';
import type { TaskWorkflowState, TaskSize } from '../api/tasks.js';

interface GatePanelProps {
  repositoryId: string;
  taskId: string;
  phase: TaskWorkflowState['phase'];
  gate: NonNullable<TaskWorkflowState['pendingHumanGate']>;
  /** The classified size shown at the contract gate; the human may override it before approving (TASK-51). */
  size?: TaskSize;
  busy: boolean;
  onApproveContract: (sizeOverride?: TaskSize) => void;
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
const SIZE_LABELS: Record<TaskSize, string> = {
  S: 'S — single-shot (skips plan + program-design)',
  M: 'M — one plan artifact (skips program-design)',
  L: 'L — full plan + program-design',
};

export function GatePanel({
  phase,
  gate,
  size,
  busy,
  onApproveContract,
  onRejectContract,
  onApprovePlan,
  onRejectPlan,
}: GatePanelProps) {
  const [sizeChoice, setSizeChoice] = useState<TaskSize | ''>(size ?? '');
  return (
    <div className="gate-panel">
      <h3>Pending human gate</h3>
      <p>
        <strong>Reason:</strong> {gate.reason}
      </p>
      <p>
        <strong>Phase:</strong> {gate.phase}
      </p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{gate.summary}</p>
      <p className="repository-path">Created at {gate.createdAt}</p>
      {gate.reason === 'task-contract-approval' ? (
        <div className="actions">
          <label>
            Size{' '}
            <select
              value={sizeChoice}
              disabled={busy}
              onChange={(e) => setSizeChoice(e.target.value as TaskSize | '')}
            >
              <option value="">(keep classified)</option>
              {(Object.keys(SIZE_LABELS) as TaskSize[]).map((s) => (
                <option key={s} value={s}>
                  {SIZE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => onApproveContract(sizeChoice === '' ? undefined : sizeChoice)}
          >
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
