import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/panel';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/utils';
import { deriveTaskTitle, relativeTime, shortId } from '@/lib/format';
import { tasksApi, type TaskStateResponse, type TaskSummary } from '../api/tasks.js';
import { useTaskListLiveRefresh } from '../hooks/useTaskListLiveRefresh.js';
import { GatePanel } from './GatePanel.js';

const POLL_INTERVAL_MS = 4000;

/**
 * Cross-task approval queue. Instead of the old repo-id/task-id lookup form, it lists every task
 * awaiting a human decision (from the durable summaries — pendingGateReason / awaiting-human status),
 * and loads the LIVE task detail for the selected one so the gate is acted on against current
 * workflow state via the shared GatePanel. No new projection table — it reuses the task summaries.
 */
export function ApprovalsPage() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selected, setSelected] = useState<{ repositoryId: string; taskId: string } | undefined>();
  const [detail, setDetail] = useState<TaskStateResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const refreshQueue = useCallback(async (): Promise<void> => {
    try {
      const all = await tasksApi.list();
      setTasks(all);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshQueue();
    const interval = setInterval(() => void refreshQueue(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshQueue]);

  useTaskListLiveRefresh(() => void refreshQueue());

  const queue = useMemo(
    () => tasks.filter((t) => t.derivedStatus === 'awaiting-human' || t.pendingGateReason != null),
    [tasks],
  );

  const loadDetail = useCallback(async (repositoryId: string, taskId: string): Promise<void> => {
    setSelected({ repositoryId, taskId });
    setDetail(undefined);
    try {
      const result = await tasksApi.getState(repositoryId, taskId);
      setDetail(result);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const repoLabel = (t: TaskSummary) => t.repositoryName ?? shortId(t.repositoryId);

  return (
    <div>
      <PageHeader title="Approvals" />

      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
        {/* The queue */}
        <Panel className="h-fit">
          <PanelHeader
            title="Queue"
            action={<span className="text-xs font-normal normal-case text-muted-foreground">{queue.length} pending</span>}
          />
          <div className="flex flex-col">
            {loading ? (
              <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : queue.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">Nothing awaiting a decision.</p>
            ) : (
              queue.map((t) => {
                const isSel = selected?.taskId === t.taskId;
                return (
                  <button
                    key={t.workflowId}
                    type="button"
                    onClick={() => void loadDetail(t.repositoryId, t.taskId)}
                    className={cn(
                      'flex flex-col gap-1 border-b px-3 py-2.5 text-left transition-colors last:border-b-0',
                      isSel ? 'bg-accent' : 'hover:bg-accent/50',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      {t.pendingGateReason && (
                        <Badge variant="approval" className="text-[10px]">
                          {t.pendingGateReason}
                        </Badge>
                      )}
                      <span className="ml-auto text-[11px] text-muted-foreground">{relativeTime(t.updatedAt)}</span>
                    </div>
                    <span className="text-sm font-medium leading-snug text-foreground">
                      {t.title ?? deriveTaskTitle(t.prompt)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{repoLabel(t)}</span>
                  </button>
                );
              })
            )}
          </div>
        </Panel>

        {/* The selected task's live gate */}
        <div>
          {!selected ? (
            <Panel>
              <PanelBody className="p-8 text-center text-sm text-muted-foreground">
                Select a task from the queue to review its gate.
              </PanelBody>
            </Panel>
          ) : !detail ? (
            <Panel>
              <PanelBody className="p-8 text-center text-sm text-muted-foreground">Loading task…</PanelBody>
            </Panel>
          ) : detail.state?.pendingHumanGate ? (
            <GatePanel
              repositoryId={selected.repositoryId}
              taskId={selected.taskId}
              gate={detail.state.pendingHumanGate}
              size={detail.state.size}
              onDecided={() => {
                void loadDetail(selected.repositoryId, selected.taskId);
                void refreshQueue();
              }}
            />
          ) : (
            <Panel>
              <PanelBody className="p-8 text-center text-sm text-muted-foreground">
                This task no longer has a pending gate — it may have just been decided.
              </PanelBody>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
