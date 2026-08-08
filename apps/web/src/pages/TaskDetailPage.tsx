import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui/panel';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/utils';
import { shortId } from '@/lib/format';
import { tasksApi, type MaintainabilityFinding, type TaskWorkflowState } from '../api/tasks.js';
import { useEventStream } from '../hooks/useEventStream.js';
import { GatePanel } from './GatePanel.js';

const POLL_INTERVAL_MS = 2000;

const TERMINAL_CONDITIONS = new Set(['failed', 'cancelled', 'completed']);

const EVENT_STREAM_LABEL: Record<string, string> = {
  connecting: '(connecting…)',
  connected: '(live)',
  reconnecting: '(reconnecting…)',
};

/**
 * Control-plane lifecycle event types, rendered distinctly from agent-produced events so a
 * phase failing / retrying / a transport drop stands out on the timeline. The value is a Tailwind
 * left-border tone; anything not listed renders with the default (muted) style.
 */
const CONTROL_PLANE_EVENT_TONE: Record<string, string> = {
  'phase-started': 'border-l-primary',
  'phase-failed': 'border-l-danger',
  'attempt-retry-scheduled': 'border-l-warn',
  'transport-error': 'border-l-danger',
  'session-started': 'border-l-primary/60',
  'session-resumed': 'border-l-primary/60',
};

export function TaskDetailPage() {
  const { repositoryId, taskId } = useParams<{ repositoryId: string; taskId: string }>();
  const [state, setState] = useState<TaskWorkflowState | undefined>();
  const [maintainabilityFindings, setMaintainabilityFindings] = useState<MaintainabilityFinding[]>(
    [],
  );
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // Live semantic-event timeline over the WebSocket, with reconnect catch-up.
  const { events, status } = useEventStream(taskId);

  async function refresh(): Promise<void> {
    if (!repositoryId || !taskId) return;
    try {
      const result = await tasksApi.getState(repositoryId, taskId);
      setState(result.state);
      setMaintainabilityFindings(result.maintainabilityFindings ?? []);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Workflow state (phase/gate) is polled; the semantic-event timeline streams over the WebSocket
  // (useEventStream) with reconnect catch-up — so the timeline is live, not on the 2s poll.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [repositoryId, taskId]);

  async function withBusy(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const back = { to: '/tasks', label: 'Tasks' };

  if (!repositoryId || !taskId) {
    return (
      <div>
        <PageHeader title="Task" back={back} />
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          Missing repositoryId or taskId.
        </div>
      </div>
    );
  }
  if (error && !state) {
    return (
      <div>
        <PageHeader title="Task" back={back} />
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      </div>
    );
  }
  if (!state) {
    return (
      <div>
        <PageHeader title="Task" back={back} />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const runtimeEntries = Object.entries(state.runtimeMsByPhase);

  return (
    <div>
      <PageHeader
        title={`Task ${shortId(taskId)}`}
        eyebrow={`Repository ${shortId(repositoryId)}`}
        back={back}
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={busy || TERMINAL_CONDITIONS.has(state.condition)}
            onClick={() => void withBusy(() => tasksApi.cancel(repositoryId, taskId))}
          >
            Cancel
          </Button>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Phase" value={state.phase} tone="accent" />
        <StatTile label="Condition" value={state.condition} />
        <StatTile label="Delivery" value={state.deliveryState} />
        <StatTile label="Size" value={state.size ?? '—'} />
        <StatTile label="Attempt" value={state.attemptNumber} />
        <StatTile
          label="Tokens in / out"
          value={`${state.tokenUsageTotal.inputTokens} / ${state.tokenUsageTotal.outputTokens}`}
        />
      </div>

      {state.phaseSet && state.phaseSet.length > 0 && (
        <Panel className="mb-4">
          <PanelHeader title="Planned phases" />
          <PanelBody className="text-sm text-muted-foreground">
            {state.phaseSet.join(' → ')}
          </PanelBody>
        </Panel>
      )}

      <Panel className="mb-4">
        <PanelHeader title="Runtime by phase" />
        <PanelBody>
          {runtimeEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No phase runtime recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {runtimeEntries.map(([phase, ms]) => (
                <li key={phase} className="flex justify-between">
                  <span className="text-muted-foreground">{phase}</span>
                  <span className="font-mono tabular-nums text-foreground">{ms}ms</span>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>

      <Panel className="mb-4">
        <PanelHeader title={`Live event timeline ${EVENT_STREAM_LABEL[status] ?? ''}`} />
        <PanelBody>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {status === 'reconnecting'
                ? 'No events yet (showing history when the stream reconnects).'
                : 'No events yet.'}
            </p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {events.map((e) => (
                <li
                  key={e.id}
                  className={cn(
                    'border-l-2 border-l-border pl-3 text-sm',
                    CONTROL_PLANE_EVENT_TONE[e.type],
                  )}
                >
                  <span className="font-mono text-xs text-muted-foreground">#{e.sequence}</span>{' '}
                  <strong className="text-foreground">{e.producer}</strong>{' '}
                  <span className="text-muted-foreground">
                    · {e.phase} · {e.type}:
                  </span>{' '}
                  {e.summary}
                </li>
              ))}
            </ol>
          )}
        </PanelBody>
      </Panel>

      <Panel className="mb-4">
        <PanelHeader title="Open findings" />
        <PanelBody>
          {state.openFindingIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
              {state.openFindingIds.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>

      {maintainabilityFindings.length > 0 && (
        <Panel className="mb-4">
          <PanelHeader title="Maintainability notes (advisory — non-blocking)" />
          <PanelBody>
            <ul className="flex flex-col gap-2 text-sm">
              {maintainabilityFindings.map((f) => (
                <li key={f.id}>
                  {f.path ? (
                    <code className="font-mono text-xs text-primary">
                      {f.path}
                      {f.line ? `:${f.line}` : ''}
                    </code>
                  ) : null}{' '}
                  <span className="text-muted-foreground">{f.description}</span>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>
      )}

      {state.pendingHumanGate && (
        <GatePanel
          repositoryId={repositoryId}
          taskId={taskId}
          phase={state.phase}
          gate={state.pendingHumanGate}
          size={state.size}
          busy={busy}
          // TaskWorkflowState does not expose contractVersion/planVersion directly (only
          // CompletionCandidate does, which isn't part of this response) — attemptNumber is used
          // as the best available stand-in, defaulting to 1 for the first attempt.
          onApproveContract={(sizeOverride) =>
            void withBusy(() =>
              tasksApi.approveContract(
                repositoryId,
                taskId,
                state.attemptNumber || 1,
                sizeOverride,
              ),
            )
          }
          onRejectContract={() =>
            void withBusy(() => tasksApi.rejectContract(repositoryId, taskId, 'rejected from UI'))
          }
          onApprovePlan={() =>
            void withBusy(() =>
              tasksApi.approvePlan(repositoryId, taskId, state.attemptNumber || 1),
            )
          }
          onRejectPlan={() =>
            void withBusy(() => tasksApi.rejectPlan(repositoryId, taskId, 'rejected from UI'))
          }
        />
      )}
    </div>
  );
}
