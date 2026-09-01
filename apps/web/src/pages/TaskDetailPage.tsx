import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui/panel';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/utils';
import { shortId } from '@/lib/format';
import { presentationFromLifecycle } from '@/lib/task-status';
import { Badge } from '@/components/ui/badge';
import {
  tasksApi,
  type ExecutionTreeResponse,
  type MaintainabilityFinding,
  type RuntimeAttributionRow,
  type TaskFreshness,
  type TaskMediaArtifact,
  type TaskStateResponse,
  type TaskWorkflowState,
  type TokenBreakdown,
} from '../api/tasks.js';
import { useDebouncedRefresh } from '../hooks/useDebouncedRefresh.js';
import { useEventStream } from '../hooks/useEventStream.js';
import { GatePanel } from './GatePanel.js';
import { ExecutionTree } from '../components/tasks/ExecutionTree.js';
import { VerificationTab } from '../components/tasks/VerificationTab.js';
import { UsageAndTime } from '../components/tasks/UsageAndTime.js';

const POLL_INTERVAL_MS = 2000;

const TERMINAL_CONDITIONS = new Set(['failed', 'cancelled', 'completed']);

const EVENT_STREAM_LABEL: Record<string, string> = {
  connecting: '(connecting…)',
  connected: '(live)',
  reconnecting: '(reconnecting…)',
};

const CONTROL_PLANE_EVENT_TONE: Record<string, string> = {
  'phase-started': 'border-l-primary',
  'phase-failed': 'border-l-danger',
  'attempt-retry-scheduled': 'border-l-warn',
  'transport-error': 'border-l-danger',
  'session-started': 'border-l-primary/60',
  'session-resumed': 'border-l-primary/60',
};

/** The canonical phase order for the rail. The active phase highlights; passed phases are muted-done. */
const PHASE_RAIL = ['specify', 'plan', 'implement', 'verify', 'qa', 'review', 'deliver'];

type Tab = 'execution' | 'verification' | 'usage';

export function TaskDetailPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { repositoryId, taskId } = useParams<{ repositoryId: string; taskId: string }>();
  const initialTab: Tab =
    searchParams.get('tab') === 'verification'
      ? 'verification'
      : searchParams.get('tab') === 'usage'
        ? 'usage'
        : 'execution';
  const [state, setState] = useState<TaskWorkflowState | undefined>();
  const [maintainabilityFindings, setMaintainabilityFindings] = useState<MaintainabilityFinding[]>([]);
  const [tokenBreakdown, setTokenBreakdown] = useState<TokenBreakdown | undefined>();
  const [runtimeAttribution, setRuntimeAttribution] = useState<RuntimeAttributionRow[] | undefined>();
  const [freshness, setFreshness] = useState<TaskFreshness | undefined>();
  const [tree, setTree] = useState<ExecutionTreeResponse | undefined>();
  const [candidateSha, setCandidateSha] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>('');
  const [media, setMedia] = useState<TaskMediaArtifact[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>(initialTab);
  const { events, status } = useEventStream(taskId);

  async function refresh(): Promise<void> {
    if (!repositoryId || !taskId) return;
    try {
      const result: TaskStateResponse = await tasksApi.getState(repositoryId, taskId);
      setState(result.state);
      setMaintainabilityFindings(result.maintainabilityFindings ?? []);
      setTokenBreakdown(result.tokenBreakdown);
      setRuntimeAttribution(result.runtimeAttribution);
      setFreshness(result.freshness);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Workflow state (phase/gate) is polled as a fallback; the semantic-event timeline streams over the
  // WebSocket (useEventStream) with reconnect catch-up. The 2s poll only guarantees eventual freshness.
  // The execution tree + projection facts (candidateSha, title) change far less often than the polled
  // lifecycle state, so they refresh alongside but tolerate their own failures.
  async function refreshTree(): Promise<void> {
    if (!repositoryId || !taskId) return;
    try {
      setTree(await tasksApi.executionTree(repositoryId, taskId));
    } catch {
      // execution tree is best-effort; keep last-known
    }
    try {
      const summary = (await tasksApi.list()).find((t) => t.taskId === taskId);
      if (summary) {
        setCandidateSha(summary.candidateSha);
        setTitle(summary.title);
        setPrompt(summary.prompt);
      }
    } catch {
      // projection facts best-effort
    }
    try {
      setMedia(await tasksApi.listMedia(repositoryId, taskId));
    } catch {
      // media best-effort
    }
  }

  useEffect(() => {
    void refresh();
    void refreshTree();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const treeInterval = setInterval(() => void refreshTree(), POLL_INTERVAL_MS * 3);
    return () => {
      clearInterval(interval);
      clearInterval(treeInterval);
    };
  }, [repositoryId, taskId]);

  // A streamed event for this task means its state advanced — re-query getState immediately (debounced)
  // instead of waiting for the poll, so the status header is live. `events` is already scoped to this
  // task's run by useEventStream. The 2s poll above stays as a fallback when the socket is down.
  const scheduleRefresh = useDebouncedRefresh(() => void refresh());
  const latestSequence = events.length > 0 ? events[events.length - 1]!.sequence : -1;
  useEffect(() => {
    if (latestSequence < 0) return;
    scheduleRefresh();
  }, [latestSequence, scheduleRefresh]);

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

  const presentation = presentationFromLifecycle(state.condition, state.phase);

  return (
    <div>
      <PageHeader
        title={title ?? `Task ${shortId(taskId)}`}
        eyebrow={`Repository ${shortId(repositoryId)}`}
        back={back}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void tasksApi
                  .create(repositoryId, prompt || `Retry of ${shortId(taskId)}`, {
                    ...(title ? { title } : {}),
                    retryOfTaskId: taskId,
                  })
                  .then((r) => navigate(`/tasks/${repositoryId}/${r.taskId}`))
                  .catch((err) => setError(err instanceof Error ? err.message : String(err)));
              }}
            >
              Retry as new task
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || TERMINAL_CONDITIONS.has(state.condition)}
              onClick={() => void withBusy(() => tasksApi.cancel(repositoryId, taskId))}
            >
              Cancel
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {freshness && !freshness.liveWorkflowAvailable && (
        <div className="mb-4 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          Live workflow state is unavailable — showing the durable projection (last indexed{' '}
          {freshness.indexedAt}).
        </div>
      )}

      {/* Gate on top: the one thing a human must act on comes before everything else. */}
      {state.pendingHumanGate && (
        <div className="mb-4">
          <GatePanel
            repositoryId={repositoryId}
            taskId={taskId}
            phase={state.phase}
            gate={state.pendingHumanGate}
            size={state.size}
            busy={busy}
            onApproveContract={(sizeOverride) =>
              void withBusy(() =>
                tasksApi.approveContract(repositoryId, taskId, state.attemptNumber || 1, sizeOverride),
              )
            }
            onRejectContract={() =>
              void withBusy(() => tasksApi.rejectContract(repositoryId, taskId, 'rejected from UI'))
            }
            onApprovePlan={() =>
              void withBusy(() => tasksApi.approvePlan(repositoryId, taskId, state.attemptNumber || 1))
            }
            onRejectPlan={() =>
              void withBusy(() => tasksApi.rejectPlan(repositoryId, taskId, 'rejected from UI'))
            }
          />
        </div>
      )}

      {/* Phase rail: where in the lifecycle this task is. */}
      <Panel className="mb-4">
        <PanelHeader
          title="Phase"
          action={<Badge variant={presentation.badgeVariant}>{presentation.label}</Badge>}
        />
        <PanelBody>
          <ol className="flex flex-wrap items-center gap-1.5 text-xs">
            {PHASE_RAIL.map((phase, i) => {
              const activeIndex = PHASE_RAIL.indexOf(state.phase);
              const isActive = phase === state.phase;
              const isPast = activeIndex >= 0 && i < activeIndex;
              return (
                <li key={phase} className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'rounded px-2 py-0.5 capitalize',
                      isActive
                        ? 'bg-primary/15 font-medium text-primary'
                        : isPast
                          ? 'text-muted-foreground'
                          : 'text-muted-foreground/50',
                    )}
                  >
                    {phase}
                  </span>
                  {i < PHASE_RAIL.length - 1 && <span aria-hidden className="text-muted-foreground/40">→</span>}
                </li>
              );
            })}
          </ol>
        </PanelBody>
      </Panel>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Condition" value={state.condition} />
        <StatTile label="Delivery" value={state.deliveryState} />
        <StatTile label="Size" value={state.size ?? '—'} />
        <StatTile label="Attempt" value={state.attemptNumber} />
      </div>

      <div className="mb-4 flex gap-1 border-b">
        {(
          [
            ['execution', 'Execution'],
            ['verification', 'Verification'],
            ['usage', 'Usage & Time'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition-colors',
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'execution' && (
        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader title="Phase attempts" />
            <PanelBody>
              {tree ? (
                <ExecutionTree tree={tree} />
              ) : (
                <p className="text-sm text-muted-foreground">Loading execution tree…</p>
              )}
            </PanelBody>
          </Panel>

          <Panel>
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
                      className={cn('border-l-2 border-l-border pl-3 text-sm', CONTROL_PLANE_EVENT_TONE[e.type])}
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

          {maintainabilityFindings.length > 0 && (
            <Panel>
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
        </div>
      )}

      {tab === 'verification' && (
        <VerificationTab state={state} media={media} candidateSha={candidateSha} />
      )}

      {tab === 'usage' && (
        <UsageAndTime
          tree={tree ?? { taskId, phaseAttempts: [] }}
          tokenBreakdown={tokenBreakdown}
          runtimeAttribution={runtimeAttribution}
        />
      )}
    </div>
  );
}
