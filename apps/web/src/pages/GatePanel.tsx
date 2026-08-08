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
import { Textarea } from '@/components/ui/textarea';
import { tasksApi, type TaskWorkflowState, type TaskSize } from '../api/tasks.js';

interface GatePanelProps {
  repositoryId: string;
  taskId: string;
  gate: NonNullable<TaskWorkflowState['pendingHumanGate']>;
  /** The classified size shown at the contract gate; the human may override it before approving. */
  size?: TaskSize;
  /** Called after a decision is applied so the caller can refresh its state. */
  onDecided?: () => void;
}

/**
 * The one reusable pending-gate panel — used on Task Detail and in the Approvals queue. Every gate
 * reason is actionable through the generalized decide-gate route (approve / deny with an optional
 * comment); there are no display-only dead ends. The one special case is the contract gate, where
 * an approve may also override the classified size — that still goes through the dedicated
 * approve-contract route so the size override is applied.
 */
const SIZE_LABELS: Record<TaskSize, string> = {
  S: 'S — single-shot (skips plan + program-design)',
  M: 'M — one plan artifact (skips program-design)',
  L: 'L — full plan + program-design',
};

const KEEP_CLASSIFIED = '__keep__';

/** A friendlier verb pair per gate reason; falls back to Approve/Deny. */
function actionLabels(reason: string): { approve: string; deny: string } {
  switch (reason) {
    case 'task-contract-approval':
      return { approve: 'Approve contract', deny: 'Reject contract' };
    case 'pr-readiness':
      return { approve: 'Mark reviewed', deny: 'Close PR' };
    default:
      return { approve: 'Approve', deny: 'Deny' };
  }
}

export function GatePanel({ repositoryId, taskId, gate, size, onDecided }: GatePanelProps) {
  const [sizeChoice, setSizeChoice] = useState<TaskSize | typeof KEEP_CLASSIFIED>(size ?? KEEP_CLASSIFIED);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const isContract = gate.reason === 'task-contract-approval';
  const labels = actionLabels(gate.reason);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onDecided?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function approve(): void {
    // The contract gate's approve carries an optional size override → dedicated route; every other
    // gate approves through the generalized decision route.
    if (isContract && sizeChoice !== KEEP_CLASSIFIED) {
      void run(() => tasksApi.approveContract(repositoryId, taskId, 1, sizeChoice));
      return;
    }
    void run(() => tasksApi.decideGate(repositoryId, taskId, gate.id, 'approve', comment || undefined));
  }

  function deny(): void {
    void run(() => tasksApi.decideGate(repositoryId, taskId, gate.id, 'deny', comment || undefined));
  }

  return (
    <Panel className="border-warn/40">
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

        {isContract && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gate-size">Size</Label>
            <Select value={sizeChoice} onValueChange={(v) => setSizeChoice(v as TaskSize | typeof KEEP_CLASSIFIED)} disabled={busy}>
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
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gate-comment">Comment (optional — feedback for a deny)</Label>
          <Textarea
            id="gate-comment"
            rows={2}
            placeholder="Why approve or deny…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={busy}
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex items-center gap-2">
          <Button disabled={busy} onClick={approve}>
            {labels.approve}
          </Button>
          <Button variant="outline" disabled={busy} onClick={deny}>
            {labels.deny}
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}
