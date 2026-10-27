import {
  type Project,
  type QueueEntry,
  type Stage,
  stageNeedsHumanApproval,
  type Task,
} from '@workbench/core';
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Lock,
  type LucideIcon,
  Plus,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';
import { usePageHeader } from '@/components/PageHeader';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { api } from '../api.js';

const ALL_PROJECTS = '__all__';

/**
 * The board collapses the lifecycle stages into a handful of columns built
 * around the four human-approval gates — the points where work waits on YOU.
 * The agent-only stretches between gates fold into coarse work buckets, so the
 * board answers "what's waiting on me, and what's the agent doing" at a glance.
 */
interface BoardColumnDef {
  id: string;
  label: string;
  /** Lifecycle stages that map into this column. */
  stages: readonly Stage[];
  icon: LucideIcon;
  /** Icon tone — warn marks the gates that wait on the human. */
  tone: string;
}

const BOARD_COLUMNS: readonly BoardColumnDef[] = [
  {
    id: 'drafting_brief',
    label: 'Drafting Brief',
    stages: ['intake', 'task_brief'],
    icon: CircleDashed,
    tone: 'text-muted-foreground',
  },
  {
    id: 'needs_brief_approval',
    label: 'Needs Brief Approval',
    stages: ['human_brief_approval'],
    icon: CircleSlash,
    tone: 'text-warn',
  },
  {
    id: 'planning',
    label: 'Planning',
    stages: ['discovery'],
    icon: CircleDot,
    tone: 'text-primary',
  },
  {
    id: 'needs_plan_approval',
    label: 'Needs Plan Approval',
    stages: ['human_plan_approval'],
    icon: CircleSlash,
    tone: 'text-warn',
  },
  {
    id: 'in_progress',
    label: 'In Progress',
    stages: ['implementation', 'static_checks', 'feature_e2e', 'agent_self_review'],
    icon: CircleDot,
    tone: 'text-primary',
  },
  {
    id: 'needs_review',
    label: 'Needs Review',
    stages: ['human_review'],
    icon: CircleSlash,
    tone: 'text-warn',
  },
  {
    id: 'needs_delivery_approval',
    label: 'Needs Delivery Approval',
    stages: ['delivery_prep', 'human_delivery_approval'],
    icon: CircleSlash,
    tone: 'text-warn',
  },
  {
    id: 'done',
    label: 'Done',
    stages: ['publish', 'closeout'],
    icon: CircleCheck,
    tone: 'text-ok',
  },
] as const;

/** Reverse index: stage -> the column it belongs to. */
const COLUMN_FOR_STAGE = new Map<Stage, BoardColumnDef>(
  BOARD_COLUMNS.flatMap((col) => col.stages.map((s) => [s, col] as const)),
);

export function Board() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const projectFilter = searchParams.get('project') ?? ALL_PROJECTS;
  const setProjectFilter = (value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === ALL_PROJECTS) next.delete('project');
        else next.set('project', value);
        return next;
      },
      { replace: true },
    );
  };
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  usePageHeader({
    title: 'Task Board',
    action: (
      <Button size="sm" onClick={() => setCreateOpen(true)}>
        <Plus className="h-4 w-4" />
        Create task
      </Button>
    ),
  });

  useEffect(() => {
    api
      .listTasks()
      .then(setTasks)
      .catch((e) => setError(String(e)));
    api
      .listProjects()
      .then(setProjects)
      .catch(() => {});
    api
      .listQueue()
      .then(setQueue)
      .catch(() => {});
  }, []);

  const projectName = useMemo(() => {
    const map = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? id;
  }, [projects]);

  const sortedProjects = useMemo(
    () =>
      [...projects].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
    [projects],
  );

  // Queue scheduling info per task, joined from the queue DAG. A task is
  // "blocked" while any of its entry's predecessors (other queue entries) hasn't
  // reached `done`; we surface the first such blocker's task title on the card.
  const queueInfo = useMemo(() => {
    const entryById = new Map(queue.map((e) => [e.id, e]));
    const titleByTaskId = new Map(tasks.map((t) => [t.id, t.title]));
    const info = new Map<string, { blockedBy: string | null; priority: number }>();
    for (const entry of queue) {
      const blocker = entry.dependsOnIds
        .map((id) => entryById.get(id))
        .find((pred) => pred && pred.status !== 'done');
      const blockedBy = blocker ? (titleByTaskId.get(blocker.taskId) ?? 'another task') : null;
      info.set(entry.taskId, { blockedBy, priority: entry.priority });
    }
    return (id: string) => info.get(id);
  }, [queue, tasks]);

  const visible = useMemo(
    () =>
      projectFilter === ALL_PROJECTS ? tasks : tasks.filter((t) => t.projectId === projectFilter),
    [tasks, projectFilter],
  );

  // Group tasks into the board columns (gates + work buckets). Every column is
  // always shown (Linear-style), even with no tasks.
  const byColumn = new Map<string, Task[]>();
  for (const t of visible) {
    const col = COLUMN_FOR_STAGE.get(t.stage);
    if (!col) continue;
    byColumn.set(col.id, [...(byColumn.get(col.id) ?? []), t]);
  }

  const projectFilterControl = (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Project</span>
      <Select value={projectFilter} onValueChange={setProjectFilter}>
        <SelectTrigger className="h-8 w-56" aria-label="Filter by project">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
          <SelectSeparator />
          {sortedProjects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && <div className="mb-3 text-sm text-danger">{error}</div>}

      <Panel className="flex min-h-0 flex-1 flex-col">
        <PanelHeader title="Pipeline" action={projectFilterControl} />
        {visible.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {tasks.length === 0 ? (
              <>
                No tasks yet. Use <strong>Create task</strong> or run{' '}
                <code className="rounded bg-secondary px-1 py-0.5 text-xs">pnpm seed</code>.
              </>
            ) : (
              'No tasks for this project.'
            )}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
            {BOARD_COLUMNS.map((col) => (
              <BoardColumn
                key={col.id}
                column={col}
                tasks={byColumn.get(col.id) ?? []}
                projectName={projectName}
                queueInfo={queueInfo}
              />
            ))}
          </div>
        )}
      </Panel>

      <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

/** Per-task scheduling info, looked up by task id (undefined = not enqueued). */
type QueueInfoLookup = (id: string) => { blockedBy: string | null; priority: number } | undefined;

/** A single Linear-style status column: header (icon + label + count) over a stack of cards. */
function BoardColumn({
  column,
  tasks,
  projectName,
  queueInfo,
}: {
  column: BoardColumnDef;
  tasks: Task[];
  projectName: (id: string) => string;
  queueInfo: QueueInfoLookup;
}) {
  const { icon: Icon, tone, label } = column;
  return (
    <section className="flex h-full w-[300px] min-w-[300px] shrink-0 flex-col">
      {/* Column header — status glyph, column label, task count. */}
      <div className="mb-2 flex items-center gap-2 px-1">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', tone)} />
        <h3 className="truncate text-[13px] font-semibold tracking-tight text-foreground">
          {label}
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
      </div>
      {/* Well fills the column height (cards sit at the top), scrolls if it overflows. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg bg-surface-2/40 p-2">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} projectName={projectName} queueInfo={queueInfo} />
        ))}
      </div>
    </section>
  );
}

/**
 * Equal-size Linear-style card. Fixed height + full column width so every card
 * reads as the same tile regardless of title length. Shows only data we have on
 * a Task: project, title, status, created date.
 */
function TaskCard({
  task,
  projectName,
  queueInfo,
}: {
  task: Task;
  projectName: (id: string) => string;
  queueInfo: QueueInfoLookup;
}) {
  const column = COLUMN_FOR_STAGE.get(task.stage);
  const Icon = column?.icon ?? CircleDot;
  const tone = column?.tone ?? 'text-muted-foreground';
  const queued = queueInfo(task.id);
  const blockedBy = queued?.blockedBy ?? null;
  const priority = queued?.priority ?? 0;
  return (
    <Link
      to={`/tasks/${task.id}`}
      className="flex min-h-[148px] flex-col gap-2 rounded-md border bg-card p-3 transition-colors hover:border-primary/70 focus-visible:border-primary focus-visible:outline-none"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] uppercase tracking-wider text-muted-foreground">
          {projectName(task.projectId)}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {priority > 0 && (
            <span className="rounded bg-surface-3 px-1 font-mono text-[10px] tabular-nums text-muted-foreground">
              P{priority}
            </span>
          )}
          <Icon className={cn('h-3.5 w-3.5 shrink-0', tone)} />
        </div>
      </div>

      <div className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
        {task.title}
      </div>

      {blockedBy && (
        <span className="inline-flex w-fit max-w-full items-center gap-1 rounded-md bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
          <Lock className="h-3 w-3 shrink-0" />
          <span className="truncate">Blocked by “{blockedBy}”</span>
        </span>
      )}

      <div className="mt-auto flex items-center justify-between">
        <StatusBadge task={task} />
        <span className="text-[11px] text-muted-foreground">{formatCreated(task.createdAt)}</span>
      </div>
    </Link>
  );
}

/** "Created Apr 29"-style footer, matching Linear's card meta line. */
function formatCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `Created ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** Maps a task's status (or pending-approval state) to a badge variant. */
export function statusVariant(task: Task): BadgeProps['variant'] {
  if (task.status === 'active' && stageNeedsHumanApproval(task.stage)) return 'approval';
  switch (task.status) {
    case 'active':
      return 'active';
    case 'done':
      return 'done';
    case 'abandoned':
      return 'abandoned';
    default:
      return 'outline';
  }
}

function StatusBadge({ task }: { task: Task }) {
  if (task.status === 'active' && stageNeedsHumanApproval(task.stage)) {
    return <Badge variant="approval">needs approval</Badge>;
  }
  return (
    <Badge variant={statusVariant(task)} className={cn(task.status === 'active' && 'text-primary')}>
      {task.status}
    </Badge>
  );
}
