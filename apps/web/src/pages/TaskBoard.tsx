import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { statusPresentation } from '@/lib/task-status';
import { deriveTaskTitle, relativeTime, shortId } from '@/lib/format';
import type { TaskSummary } from '../api/tasks.js';

/**
 * Read-only board view of the SAME task summaries the list shows (shared filters, query, cards, and
 * derived status). Columns are the canonical derived-status set — runtime truth, not a manual
 * workflow the user drags between. Phase is a badge on the card, not a column (ten phase columns
 * would not stay legible). Cards link to Task Detail.
 */
const COLUMNS: { status: string; label: string }[] = [
  { status: 'queued', label: 'Queued' },
  { status: 'planning', label: 'Planning' },
  { status: 'running', label: 'Running' },
  { status: 'awaiting-human', label: 'Awaiting Human' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'failed', label: 'Failed' },
  { status: 'completed', label: 'Completed' },
];

// Statuses not given their own column fold into the nearest sensible one.
const COLUMN_ALIAS: Record<string, string> = {
  'awaiting-external': 'awaiting-human',
  cancelled: 'failed',
};

function columnFor(status: string): string {
  if (COLUMNS.some((c) => c.status === status)) return status;
  return COLUMN_ALIAS[status] ?? 'running';
}

export function TaskBoard({ tasks, repoLabel }: { tasks: TaskSummary[]; repoLabel: (t: TaskSummary) => string }) {
  const navigate = useNavigate();

  const byColumn = new Map<string, TaskSummary[]>();
  for (const col of COLUMNS) byColumn.set(col.status, []);
  for (const task of tasks) {
    byColumn.get(columnFor(task.derivedStatus))?.push(task);
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {COLUMNS.map((col) => {
        const items = byColumn.get(col.status) ?? [];
        return (
          <div key={col.status} className="flex w-64 shrink-0 flex-col rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{col.label}</span>
              <span className="rounded bg-surface-2 px-1.5 text-xs tabular-nums text-muted-foreground">{items.length}</span>
            </div>
            <div className="flex flex-col gap-2 p-2">
              {items.length === 0 ? (
                <p className="px-1 py-3 text-center text-xs text-muted-foreground">—</p>
              ) : (
                items.map((task) => {
                  const title = task.title ?? deriveTaskTitle(task.prompt);
                  return (
                    <button
                      key={task.workflowId}
                      type="button"
                      onClick={() => navigate(`/tasks/${task.repositoryId}/${task.taskId}`)}
                      className="flex flex-col gap-1.5 rounded-md border bg-surface-2 p-2.5 text-left transition-colors hover:border-primary/50"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px] text-primary">{shortId(task.taskId)}</span>
                        {task.retryOfTaskId && (
                          <Badge variant="outline" className="text-[10px]">
                            retry
                          </Badge>
                        )}
                      </div>
                      <div className="line-clamp-2 text-sm font-medium leading-snug text-foreground">{title}</div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span>{repoLabel(task)}</span>
                        <span aria-hidden>·</span>
                        <span className="capitalize">{task.phase}</span>
                        {task.attemptCount > 1 && <span>· attempt {task.attemptCount}</span>}
                      </div>
                      {task.pendingGateReason && (
                        <Badge variant={statusPresentation('awaiting-human').variant} className="w-fit text-[10px]">
                          {task.pendingGateReason}
                        </Badge>
                      )}
                      <div className="text-[11px] text-muted-foreground">{relativeTime(task.updatedAt)}</div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
