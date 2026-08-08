import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TaskWorkflowState, TaskSize } from '../api/tasks.js';

interface GatePanelProps {
  repositoryId: string;
  taskId: string;
  phase: TaskWorkflowState['phase'];
  gate: NonNullable<TaskWorkflowState['pendingHumanGate']>;
  /** The classified size shown at the contract gate; the human may override it before approving. */
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

const KEEP_CLASSIFIED = '__keep__';

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
  const [sizeChoice, setSizeChoice] = useState<TaskSize | typeof KEEP_CLASSIFIED>(
    size ?? KEEP_CLASSIFIED,
  );

  return (
    <Panel className="mt-6 border-warn/40">
      <PanelHeader title="Pending human gate" />
      <PanelBody className="flex flex-col gap-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <span className="text-muted-foreground">Reason</span>
          <span className="font-medium text-foreground">{gate.reason}</span>
          <span className="text-muted-foreground">Phase</span>
          <span className="font-medium text-foreground">{gate.phase}</span>
          <span className="text-muted-foreground">Created</span>
          <span className="font-mono text-xs text-muted-foreground">{gate.createdAt}</span>
        </div>

        {gate.summary && (
          <p className="whitespace-pre-wrap rounded-md border bg-surface-2 px-3 py-2 text-sm text-foreground">
            {gate.summary}
          </p>
        )}

        {gate.reason === 'task-contract-approval' ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gate-size">Size</Label>
              <Select
                value={sizeChoice}
                onValueChange={(v) => setSizeChoice(v as TaskSize | typeof KEEP_CLASSIFIED)}
                disabled={busy}
              >
                <SelectTrigger id="gate-size" className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP_CLASSIFIED}>(keep classified)</SelectItem>
                  {(Object.keys(SIZE_LABELS) as TaskSize[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {SIZE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  onApproveContract(sizeChoice === KEEP_CLASSIFIED ? undefined : sizeChoice)
                }
              >
                Approve contract
              </Button>
              <Button variant="outline" disabled={busy} onClick={onRejectContract}>
                Reject contract
              </Button>
            </div>
          </div>
        ) : gate.reason === 'pr-readiness' ? (
          <p className="text-sm text-muted-foreground">
            This is a release-phase gate (pr-readiness). No dedicated daemon route exists for it
            yet, so no action is available here — display only.
          </p>
        ) : phase === 'plan' ? (
          <div className="flex items-center gap-2">
            <Button disabled={busy} onClick={onApprovePlan}>
              Approve plan
            </Button>
            <Button variant="outline" disabled={busy} onClick={onRejectPlan}>
              Reject plan
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No dedicated daemon action is wired up for gate reason &quot;{gate.reason}&quot; —
            display only.
          </p>
        )}
      </PanelBody>
    </Panel>
  );
}
