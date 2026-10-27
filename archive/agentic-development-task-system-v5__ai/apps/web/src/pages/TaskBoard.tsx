import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/layout/PageHeader';
import { statusPresentation, DERIVED_STATUS_LABEL, type DerivedTaskStatus } from '@/lib/task-status';
import { deriveTaskTitle, formatTokens, relativeTime, shortId } from '@/lib/format';
import { tasksApi, type TaskSummary } from '../api/tasks.js';
import { useTaskListLiveRefresh } from '../hooks/useTaskListLiveRefresh.js';

const POLL_INTERVAL_MS = 4000;

/**
 * Read-only Task Board at /board. Columns are EXACTLY the canonical derived-status label set — this is
 * runtime truth read from the task_summary projection, not a manual workflow a human drags between, so
 * the cards are not draggable. Phase is a badge on the card (ten phase columns would not stay legible).
 * Cards never surface a runId — they show title/repo/derived status/phase/phase-attempt/pending-gate/
 * open-finding count/total tokens/last activity/delivery/retry-lineage and link to Task Detail.
 */
const COLUMNS: DerivedTaskStatus[] = [
  'queued',
  'planning',
  'running',
  'awaiting-human',
  'awaiting-external',
  'blocked',
  'completed',
  'failed',
  'cancelled',
];

export function TaskBoard() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    try {
      setTasks(await tasksApi.list());
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

  const byColumn = useMemo(() => {
    const map = new Map<DerivedTaskStatus, TaskSummary[]>();
    for (const col of COLUMNS) map.set(col, []);
    for (const task of tasks) {
      const col = (task.derivedStatus as DerivedTaskStatus) in DERIVED_STATUS_LABEL
        ? (task.derivedStatus as DerivedTaskStatus)
        : 'running';
      map.get(col)?.push(task);
    }
    return map;
  }, [tasks]);

  const repoLabel = (t: TaskSummary) => t.repositoryName ?? shortId(t.repositoryId);

  return (
    <div>
      <PageHeader title="Task Board" />

      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((col) => {
            const items = byColumn.get(col) ?? [];
            return (
              <div key={col} className="flex w-64 shrink-0 flex-col rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {DERIVED_STATUS_LABEL[col]}
                  </span>
                  <span className="rounded bg-surface-2 px-1.5 text-xs tabular-nums text-muted-foreground">
                    {items.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  {items.length === 0 ? (
                    <p className="px-1 py-3 text-center text-xs text-muted-foreground">—</p>
                  ) : (
                    items.map((task) => (
                      <TaskCard key={task.taskId} task={task} repoLabel={repoLabel(task)} onOpen={() => navigate(`/tasks/${task.repositoryId}/${task.taskId}`)} />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task,
  repoLabel,
  onOpen,
}: {
  task: TaskSummary;
  repoLabel: string;
  onOpen: () => void;
}) {
  const status = statusPresentation(task.derivedStatus);
  const title = task.title ?? deriveTaskTitle(task.prompt);
  const totalTokens = task.inputTokens + task.outputTokens;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-1.5 rounded-md border bg-surface-2 p-2.5 text-left transition-colors hover:border-primary/50"
    >
      <div className="flex items-center gap-1.5">
        <Badge variant={status.badgeVariant} className="text-[10px]">
          {status.label}
        </Badge>
        {task.retryOfTaskId && (
          <Badge variant="outline" className="text-[10px]">
            retry
          </Badge>
        )}
        {task.pullRequestUrl && (
          <Badge variant="done" className="text-[10px]">
            PR
          </Badge>
        )}
      </div>
      <div className="line-clamp-2 text-sm font-medium leading-snug text-foreground">{title}</div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>{repoLabel}</span>
        <span aria-hidden>·</span>
        <span className="capitalize">{task.phase}</span>
        {task.attemptCount > 1 && <span>· attempt {task.attemptCount}</span>}
      </div>
      {task.pendingGateReason && (
        <Badge variant="approval" className="w-fit text-[10px]">
          {task.pendingGateReason}
        </Badge>
      )}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {formatTokens(totalTokens)} tok
          {task.openFindingCount > 0 ? ` · ${task.openFindingCount} finding${task.openFindingCount === 1 ? '' : 's'}` : ''}
        </span>
        <span>{relativeTime(task.updatedAt)}</span>
      </div>
    </button>
  );
}
