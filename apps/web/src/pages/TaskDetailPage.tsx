import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { tasksApi, type TaskWorkflowState } from '../api/tasks.js';
import { useEventStream } from '../hooks/useEventStream.js';
import { GatePanel } from './GatePanel.js';
import { Button } from '../components/Button.js';
import { CopyButton } from '../components/CopyButton.js';
import { ErrorText } from '../components/ErrorText.js';
import { shortId } from '../lib/format.js';

const POLL_INTERVAL_MS = 2000;

const TERMINAL_CONDITIONS = new Set(['failed', 'cancelled', 'completed']);

/**
 * Control-plane lifecycle event types (TASK-34), rendered distinctly from agent-produced events so a
 * phase failing / retrying / a transport drop stands out on the timeline. The value is a CSS modifier
 * class; anything not listed renders with the default agent-event style.
 */
const CONTROL_PLANE_EVENT_CLASS: Record<string, string> = {
  'phase-started': 'event--phase-started',
  'phase-failed': 'event--phase-failed',
  'attempt-retry-scheduled': 'event--retry',
  'transport-error': 'event--transport-error',
  'session-started': 'event--session',
  'session-resumed': 'event--session',
};

export function TaskDetailPage() {
  const { repositoryId, taskId } = useParams<{ repositoryId: string; taskId: string }>();
  const [state, setState] = useState<TaskWorkflowState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // Live semantic-event timeline over the WebSocket, with reconnect catch-up (TASK-23).
  const { events, connected } = useEventStream(taskId);

  async function refresh(): Promise<void> {
    if (!repositoryId || !taskId) return;
    try {
      const result = await tasksApi.getState(repositoryId, taskId);
      setState(result.state);
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

  if (!repositoryId || !taskId) return <ErrorText>Missing repositoryId or taskId.</ErrorText>;
  if (error && !state) return <ErrorText>{error}</ErrorText>;
  if (!state) return <p>Loading…</p>;

  return (
    <div className="page">
      <header className="page__header">
        <h1>
          Task <span className="mono-id">{shortId(taskId)}</span>
        </h1>
        <CopyButton value={taskId} label="Copy full task ID" />
      </header>
      <p className="repository-path">
        Repository <span className="mono-id">{shortId(repositoryId)}</span>
        <CopyButton value={repositoryId} label="Copy full repository ID" />
      </p>
      {error && <ErrorText>{error}</ErrorText>}
      <dl className="task-facts">
        <dt>Phase</dt>
        <dd>{state.phase}</dd>
        <dt>Condition</dt>
        <dd>{state.condition}</dd>
        <dt>Delivery state</dt>
        <dd>{state.deliveryState}</dd>
        <dt>Attempt number</dt>
        <dd>{state.attemptNumber}</dd>
        <dt>Token usage (input / output)</dt>
        <dd>
          {state.tokenUsageTotal.inputTokens} / {state.tokenUsageTotal.outputTokens}
        </dd>
      </dl>

      <h3>Runtime by phase</h3>
      {Object.keys(state.runtimeMsByPhase).length === 0 ? (
        <p>No phase runtime recorded yet.</p>
      ) : (
        <ul>
          {Object.entries(state.runtimeMsByPhase).map(([phase, ms]) => (
            <li key={phase}>
              {phase}: {ms}ms
            </li>
          ))}
        </ul>
      )}

      <h3>Live event timeline {connected ? '(live)' : '(reconnecting…)'}</h3>
      {events.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <ol className="event-timeline">
          {events.map((e) => {
            const controlPlaneClass = CONTROL_PLANE_EVENT_CLASS[e.type];
            return (
              <li key={e.id} className={controlPlaneClass}>
                <span className="event-seq">#{e.sequence}</span> <strong>{e.producer}</strong> · {e.phase} ·{' '}
                {e.type}: {e.summary}
              </li>
            );
          })}
        </ol>
      )}

      <h3>Open findings</h3>
      {state.openFindingIds.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {state.openFindingIds.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      )}

      {state.pendingHumanGate && (
        <GatePanel
          repositoryId={repositoryId}
          taskId={taskId}
          phase={state.phase}
          gate={state.pendingHumanGate}
          busy={busy}
          // TaskWorkflowState does not expose contractVersion/planVersion directly (only
          // CompletionCandidate does, which isn't part of this response) — attemptNumber is used
          // as the best available stand-in, defaulting to 1 for the first attempt.
          onApproveContract={() =>
            void withBusy(() => tasksApi.approveContract(repositoryId, taskId, state.attemptNumber || 1))
          }
          onRejectContract={() => void withBusy(() => tasksApi.rejectContract(repositoryId, taskId, 'rejected from UI'))}
          onApprovePlan={() => void withBusy(() => tasksApi.approvePlan(repositoryId, taskId, state.attemptNumber || 1))}
          onRejectPlan={() => void withBusy(() => tasksApi.rejectPlan(repositoryId, taskId, 'rejected from UI'))}
        />
      )}

      <div className="actions">
        <Button
          variant="danger"
          disabled={busy || TERMINAL_CONDITIONS.has(state.condition)}
          onClick={() => void withBusy(() => tasksApi.cancel(repositoryId, taskId))}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
