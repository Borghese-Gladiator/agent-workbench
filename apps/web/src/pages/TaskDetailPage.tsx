import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui/panel';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/utils';
import { deriveTaskTitle, formatDuration, formatTokens, relativeTime, shortId } from '@/lib/format';
import { deriveDerivedStatus, statusPresentation } from '@/lib/task-status';
import {
  tasksApi,
  type MaintainabilityFinding,
  type TaskFreshness,
  type TaskStateResponse,
  type TaskWorkflowState,
  type TokenBreakdown,
} from '../api/tasks.js';
import { useEventStream } from '../hooks/useEventStream.js';
import { GatePanel } from './GatePanel.js';

const POLL_INTERVAL_MS = 2000;

const TERMINAL_CONDITIONS = new Set(['failed', 'cancelled', 'completed']);

const CONTROL_PLANE_EVENT_TONE: Record<string, string> = {
  'phase-started': 'border-l-primary',
  'phase-failed': 'border-l-danger',
  'attempt-retry-scheduled': 'border-l-warn',
  'transport-error': 'border-l-danger',
  'session-started': 'border-l-primary/60',
  'session-resumed': 'border-l-primary/60',
};

const TABS = ['overview', 'attempts', 'verification', 'usage', 'activity'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  attempts: 'Attempts',
  verification: 'Verification',
  usage: 'Usage',
  activity: 'Activity',
};

export function TaskDetailPage() {
  const { repositoryId, taskId } = useParams<{ repositoryId: string; taskId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as Tab) : 'overview';

  const [state, setState] = useState<TaskWorkflowState | undefined>();
  const [maintainabilityFindings, setMaintainabilityFindings] = useState<MaintainabilityFinding[]>([]);
  const [tokenBreakdown, setTokenBreakdown] = useState<TokenBreakdown | undefined>();
  const [freshness, setFreshness] = useState<TaskFreshness | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const { events, status } = useEventStream(taskId);

  async function refresh(): Promise<void> {
    if (!repositoryId || !taskId) return;
    try {
      const result: TaskStateResponse = await tasksApi.getState(repositoryId, taskId);
      setState(result.state);
      setMaintainabilityFindings(result.maintainabilityFindings ?? []);
      setTokenBreakdown(result.tokenBreakdown);
      setFreshness(result.freshness);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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
        <ErrorBanner message="Missing repositoryId or taskId." />
      </div>
    );
  }
  if (error && !state) {
    return (
      <div>
        <PageHeader title="Task" back={back} />
        <ErrorBanner message={error} />
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

  const statusPres = statusPresentation(deriveDerivedStatus(state.condition, state.phase));
  const title = deriveTaskTitle(state.prompt ?? `Task ${shortId(taskId)}`);

  return (
    <div>
      {/* Compact status header: title + status + provenance + primary action. */}
      <PageHeader
        title={title}
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

      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
        <Badge variant={statusPres.variant}>{statusPres.label}</Badge>
        <span className="capitalize">{state.phase}</span>
        <span aria-hidden>·</span>
        <span className="font-mono text-xs">{shortId(taskId)}</span>
      </div>

      {freshness && !freshness.liveWorkflowAvailable && (
        <div className="mb-4 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          Live workflow state is unavailable — showing the last indexed state
          {freshness.indexedAt ? ` from ${relativeTime(freshness.indexedAt)}` : ''}. The list may update shortly.
        </div>
      )}

      {error && <ErrorBanner className="mb-4" message={error} />}

      {/* The pending gate is the most important thing on the page — it sits above the tabs. */}
      {state.pendingHumanGate && (
        <div className="mb-5">
          <GatePanel
            repositoryId={repositoryId}
            taskId={taskId}
            gate={state.pendingHumanGate}
            size={state.size}
            onDecided={() => void refresh()}
          />
        </div>
      )}

      <TabBar tab={tab} onSelect={(t) => setSearchParams((p) => (p.set('tab', t), p), { replace: true })} />

      <div className="mt-4">
        {tab === 'overview' && (
          <OverviewTab state={state} maintainability={maintainabilityFindings} />
        )}
        {tab === 'attempts' && <AttemptsTab state={state} />}
        {tab === 'verification' && <VerificationTab openFindingIds={state.openFindingIds} evidenceIds={state.latestCandidateEvidenceIds} />}
        {tab === 'usage' && <UsageTab state={state} tokenBreakdown={tokenBreakdown} />}
        {tab === 'activity' && <ActivityTab events={events} status={status} />}
      </div>
    </div>
  );
}

function TabBar({ tab, onSelect }: { tab: Tab; onSelect: (t: Tab) => void }) {
  return (
    <div className="flex gap-1 border-b" role="tablist">
      {TABS.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={t === tab}
          onClick={() => onSelect(t)}
          className={cn(
            'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            t === tab
              ? 'border-b-primary text-foreground'
              : 'border-b-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {TAB_LABELS[t]}
        </button>
      ))}
    </div>
  );
}

function OverviewTab({ state, maintainability }: { state: TaskWorkflowState; maintainability: MaintainabilityFinding[] }) {
  const totalTokens = state.tokenUsageTotal.inputTokens + state.tokenUsageTotal.outputTokens;
  const totalRuntimeMs = Object.values(state.runtimeMsByPhase).reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Current phase attempt" value={state.attemptNumber} />
        <StatTile label="Tokens" value={formatTokens(totalTokens)} />
        <StatTile label="Elapsed" value={totalRuntimeMs > 0 ? formatDuration(totalRuntimeMs) : '—'} />
        <StatTile label="Open findings" value={state.openFindingIds.length} tone={state.openFindingIds.length > 0 ? 'warn' : 'default'} />
      </div>

      <Panel>
        <PanelHeader title="Prompt" />
        <PanelBody className="whitespace-pre-wrap text-sm text-foreground">{state.prompt ?? '—'}</PanelBody>
      </Panel>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Panel>
          <PanelHeader title="Workflow" />
          <PanelBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Condition</dt>
              <dd className="text-foreground">{state.condition}</dd>
              <dt className="text-muted-foreground">Delivery</dt>
              <dd className="text-foreground">{state.deliveryState}</dd>
              <dt className="text-muted-foreground">Size</dt>
              <dd className="text-foreground">{state.size ?? '—'}</dd>
              <dt className="text-muted-foreground">Planned phases</dt>
              <dd className="text-foreground">{state.phaseSet && state.phaseSet.length > 0 ? state.phaseSet.join(' → ') : '—'}</dd>
            </dl>
          </PanelBody>
        </Panel>

        {maintainability.length > 0 && (
          <Panel>
            <PanelHeader title="Maintainability notes (advisory)" />
            <PanelBody>
              <ul className="flex flex-col gap-2 text-sm">
                {maintainability.map((f) => (
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
    </div>
  );
}

function AttemptsTab({ state }: { state: TaskWorkflowState }) {
  // Phase-level view derived from the runtime-by-phase map + the planned phase set. A structured
  // per-attempt drilldown (agent sessions, invocations) is the next iteration; this already gives
  // the phase progression + where wall-clock went, keyed off phase (not the single run).
  const phases = state.phaseSet && state.phaseSet.length > 0 ? state.phaseSet : Object.keys(state.runtimeMsByPhase);
  if (phases.length === 0) {
    return <p className="text-sm text-muted-foreground">No phase activity recorded yet.</p>;
  }
  const currentIndex = phases.indexOf(state.phase);
  return (
    <Panel>
      <PanelHeader title="Phases" />
      <PanelBody>
        <ul className="flex flex-col gap-1.5 text-sm">
          {phases.map((phase, i) => {
            const ms = state.runtimeMsByPhase[phase];
            const isCurrent = phase === state.phase;
            const done = currentIndex >= 0 && i < currentIndex;
            return (
              <li key={phase} className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className={cn('h-1.5 w-1.5 rounded-full', isCurrent ? 'bg-primary' : done ? 'bg-ok' : 'bg-border')} />
                  <span className={cn('capitalize', isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground')}>{phase}</span>
                  {isCurrent && <span className="text-xs text-muted-foreground">(attempt {state.attemptNumber})</span>}
                </span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{ms ? formatDuration(ms) : '—'}</span>
              </li>
            );
          })}
        </ul>
      </PanelBody>
    </Panel>
  );
}

function VerificationTab({ openFindingIds, evidenceIds }: { openFindingIds: string[]; evidenceIds: string[] }) {
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title="Open findings" />
        <PanelBody>
          {openFindingIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">None — nothing blocking.</p>
          ) : (
            <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
              {openFindingIds.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader title="Candidate evidence" />
        <PanelBody>
          {evidenceIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No candidate evidence recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
              {evidenceIds.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

function UsageTab({ state, tokenBreakdown }: { state: TaskWorkflowState; tokenBreakdown?: TokenBreakdown }) {
  const totals = tokenBreakdown?.totals;
  const runtimeEntries = Object.entries(state.runtimeMsByPhase);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Input tokens" value={formatTokens(totals?.inputTokens ?? state.tokenUsageTotal.inputTokens)} />
        <StatTile label="Output tokens" value={formatTokens(totals?.outputTokens ?? state.tokenUsageTotal.outputTokens)} />
        <StatTile
          label="Total tokens"
          value={formatTokens((totals?.inputTokens ?? state.tokenUsageTotal.inputTokens) + (totals?.outputTokens ?? state.tokenUsageTotal.outputTokens))}
          tone="accent"
        />
        <StatTile label="Cost" value={totals?.costUsd != null ? `$${totals.costUsd.toFixed(2)}` : '—'} />
      </div>

      {tokenBreakdown && Object.keys(tokenBreakdown.byModel).length > 0 && (
        <Panel>
          <PanelHeader title="By model" />
          <PanelBody>
            <ul className="flex flex-col gap-1 text-sm">
              {Object.entries(tokenBreakdown.byModel).map(([model, m]) => (
                <li key={model} className="flex items-center justify-between">
                  <span className="font-mono text-xs text-foreground">{model}</span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {formatTokens(m.inputTokens)} in / {formatTokens(m.outputTokens)} out
                    {m.costUsd ? ` · $${m.costUsd.toFixed(2)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>
      )}

      <Panel>
        <PanelHeader title="Runtime by phase" />
        <PanelBody>
          {runtimeEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No phase runtime recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {runtimeEntries.map(([phase, ms]) => (
                <li key={phase} className="flex justify-between">
                  <span className="capitalize text-muted-foreground">{phase}</span>
                  <span className="font-mono tabular-nums text-foreground">{formatDuration(ms)}</span>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

function ActivityTab({ events, status }: { events: ReturnType<typeof useEventStream>['events']; status: string }) {
  const liveLabel =
    status === 'connected'
      ? 'Connected — live'
      : status === 'reconnecting'
        ? 'Reconnecting… showing persisted activity'
        : 'Connecting to live updates…';
  return (
    <Panel>
      <PanelHeader title="Activity" action={<span className="text-xs font-normal normal-case text-muted-foreground">{liveLabel}</span>} />
      <PanelBody>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {status === 'connected' ? 'Connected — no activity recorded yet.' : 'No activity yet.'}
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {events.map((e) => (
              <li key={e.id} className={cn('border-l-2 border-l-border pl-3 text-sm', CONTROL_PLANE_EVENT_TONE[e.type])}>
                <span className="font-mono text-xs text-muted-foreground">#{e.sequence}</span>{' '}
                <strong className="text-foreground">{e.producer}</strong>{' '}
                <span className="text-muted-foreground">· {e.phase} · {e.type}:</span> {e.summary}
              </li>
            ))}
          </ol>
        )}
      </PanelBody>
    </Panel>
  );
}

function ErrorBanner({ message, className }: { message: string; className?: string }) {
  return (
    <div className={cn('rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger', className)}>
      {message}
    </div>
  );
}
