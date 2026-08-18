import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelBody, PanelHeader, StatTile } from '@/components/ui/panel';
import { PageHeader } from '@/components/layout/PageHeader';
import { statusPresentation, DERIVED_STATUS_LABEL, type DerivedTaskStatus } from '@/lib/task-status';
import { deriveTaskTitle, relativeTime, shortId } from '@/lib/format';
import { overviewApi, type OverviewResponse } from '../api/client.js';
import { useTaskListLiveRefresh } from '../hooks/useTaskListLiveRefresh.js';

const POLL_INTERVAL_MS = 5000;

/**
 * Factory overview — the landing page at `/`. Reads the durable GET /api/overview (no Temporal
 * fan-out): a factory-health strip, the needs-attention set, per-status counts, and a recent-activity
 * feed. All of it comes from the task_summary projection, so it stays responsive.
 */
export function OverviewPage() {
  const navigate = useNavigate();
  const [overview, setOverview] = useState<OverviewResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    try {
      setOverview(await overviewApi.get());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useTaskListLiveRefresh(() => void refresh());

  if (error && !overview) {
    return (
      <div>
        <PageHeader title="Factory" />
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      </div>
    );
  }
  if (!overview) {
    return (
      <div>
        <PageHeader title="Factory" />
        <p className="text-sm text-muted-foreground">{loading ? 'Loading…' : 'No data.'}</p>
      </div>
    );
  }

  const { factoryHealth, needsAttention, currentState, recentActivity } = overview;

  return (
    <div>
      <PageHeader title="Factory" />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Total" value={factoryHealth.total} />
        <StatTile label="Running" value={factoryHealth.running} tone="accent" />
        <StatTile
          label="Awaiting human"
          value={factoryHealth.awaitingHuman}
          tone={factoryHealth.awaitingHuman > 0 ? 'warn' : 'default'}
        />
        <StatTile
          label="Blocked"
          value={factoryHealth.blocked}
          tone={factoryHealth.blocked > 0 ? 'danger' : 'default'}
        />
        <StatTile
          label="Failed"
          value={factoryHealth.failed}
          tone={factoryHealth.failed > 0 ? 'danger' : 'default'}
        />
        <StatTile label="Completed" value={factoryHealth.completed} tone="ok" />
      </div>

      <Panel className="mb-6">
        <PanelHeader title="Needs attention" />
        <PanelBody>
          {needsAttention.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing needs a human right now.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {needsAttention.map((t) => {
                const status = statusPresentation(t.derivedStatus);
                return (
                  <li key={t.taskId}>
                    <button
                      type="button"
                      onClick={() => navigate(`/tasks/${t.repositoryId}/${t.taskId}`)}
                      className="flex w-full items-center justify-between gap-3 rounded-md border bg-surface-2 px-3 py-2 text-left transition-colors hover:border-primary/50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {t.title ?? deriveTaskTitle(t.prompt)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t.repositoryName ?? shortId(t.repositoryId)}
                          {t.pendingGateReason ? ` · ${t.pendingGateReason}` : ''}
                        </span>
                      </span>
                      <Badge variant={status.badgeVariant}>{status.label}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </PanelBody>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Current state" />
          <PanelBody>
            <ul className="flex flex-col gap-1.5 text-sm">
              {(Object.keys(DERIVED_STATUS_LABEL) as DerivedTaskStatus[]).map((status) => (
                <li key={status} className="flex items-center justify-between">
                  <span className="text-muted-foreground">{DERIVED_STATUS_LABEL[status]}</span>
                  <span className="font-mono tabular-nums text-foreground">
                    {currentState[status] ?? 0}
                  </span>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Recent activity" />
          <PanelBody>
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {recentActivity.map((item) => {
                  const status = statusPresentation(item.derivedStatus);
                  return (
                    <li key={item.taskId}>
                      <button
                        type="button"
                        onClick={() => navigate(`/tasks/${item.repositoryId}/${item.taskId}`)}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-accent/60"
                      >
                        <span className="min-w-0 truncate text-foreground">
                          {item.title ?? shortId(item.taskId)}
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant={status.badgeVariant}>{status.label}</Badge>
                          {relativeTime(item.at)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
