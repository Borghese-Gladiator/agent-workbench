import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useEpics, useInitiatives, useEpic, useCreateEpic, useUpdateEpic } from '@client/services/hooks';
import { StatusBadge } from '@client/components/StatusBadge';
import { KindIcon } from '@client/components/KindIcon';
import { timeAgo } from '@client/utils/time';
import { Button } from '@client/components/ui/button';
import { Input } from '@client/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@client/components/ui/select';
import { ChevronDown, ChevronRight, Layers, Plus } from 'lucide-react';
import type { WorkItem } from '@shared/types';

export function EpicsPage() {
  const { data: epics, isLoading, error } = useEpics();
  const { data: initiatives } = useInitiatives();
  const [expandedEpicId, setExpandedEpicId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (error) return <div className="p-6 text-destructive">Error: {(error as Error).message}</div>;

  // Group epics by initiative
  const initiativeMap = new Map<string | null, typeof epics>();
  for (const epic of epics ?? []) {
    const key = epic.initiativeId;
    if (!initiativeMap.has(key)) initiativeMap.set(key, []);
    initiativeMap.get(key)!.push(epic);
  }

  const initiativeNames = new Map<string, string>();
  for (const init of initiatives ?? []) {
    initiativeNames.set(init.id, init.name);
  }

  const groups = Array.from(initiativeMap.entries()).sort(([a], [b]) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return (initiativeNames.get(a) ?? '').localeCompare(initiativeNames.get(b) ?? '');
  });

  return (
    <div className="h-full flex flex-col">
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Epics</h2>
            <p className="text-sm text-muted-foreground">Features and capabilities grouped by initiative</p>
          </div>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" /> Create Epic
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {showCreate && (
          <CreateEpicForm
            initiatives={initiatives ?? []}
            onClose={() => setShowCreate(false)}
          />
        )}

        {(!epics || epics.length === 0) ? (
          <div className="text-center py-12 text-muted-foreground">
            <Layers className="mx-auto size-10 mb-3 opacity-40" />
            <p className="text-lg mb-2">No epics yet</p>
            <p className="text-sm">Create an epic to start organizing work.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(([initId, groupEpics]) => (
              <div key={initId ?? 'unassigned'}>
                <h3 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">
                  {initId ? initiativeNames.get(initId) ?? 'Unknown Initiative' : 'No Initiative'}
                </h3>
                <div className="space-y-2">
                  {groupEpics!.map((epic) => (
                    <EpicRow
                      key={epic.id}
                      epic={epic}
                      isExpanded={expandedEpicId === epic.id}
                      onToggle={() => setExpandedEpicId(expandedEpicId === epic.id ? null : epic.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CreateEpicForm({ initiatives, onClose }: {
  initiatives: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [initiativeId, setInitiativeId] = useState('');
  const createEpic = useCreateEpic();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    createEpic.mutate(
      { title: title.trim(), initiative_id: initiativeId || undefined },
      { onSuccess: () => { onClose(); } },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="border border-border rounded-lg p-4 mb-6 space-y-3">
      <Input
        autoFocus
        placeholder="Epic title..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Select value={initiativeId || '__none__'} onValueChange={(v) => setInitiativeId(v === '__none__' ? '' : v)}>
          <SelectTrigger className="w-[200px] h-8 text-sm">
            <SelectValue placeholder="Initiative (optional)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">No initiative</SelectItem>
            {initiatives.map((init) => (
              <SelectItem key={init.id} value={init.id}>{init.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={!title.trim()}>Create</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

function EpicRow({ epic, isExpanded, onToggle }: {
  epic: { id: string; title: string; status: string; workItemCount: number; doneCount: number; updatedAt: string };
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const updateEpic = useUpdateEpic();
  const progress = epic.workItemCount > 0 ? Math.round((epic.doneCount / epic.workItemCount) * 100) : 0;

  function handleStatusChange(newStatus: string) {
    updateEpic.mutate({ id: epic.id, status: newStatus });
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors">
        <button onClick={onToggle} className="shrink-0">
          {isExpanded ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
        </button>
        <div className="flex-1 min-w-0">
          <Link
            to={`/epics/${epic.id}`}
            className="text-sm font-medium hover:text-blue-400 transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            {epic.title}
          </Link>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          <Select value={epic.status} onValueChange={handleStatusChange}>
            <SelectTrigger className="w-[110px] h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">open</SelectItem>
              <SelectItem value="in_progress">in progress</SelectItem>
              <SelectItem value="done">done</SelectItem>
              <SelectItem value="archived">archived</SelectItem>
            </SelectContent>
          </Select>
          <span>{epic.doneCount}/{epic.workItemCount}</span>
          <div className="w-20 bg-muted rounded-full h-2">
            <div className="bg-emerald-500 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
          <span className="w-16 text-right">{timeAgo(epic.updatedAt)}</span>
        </div>
      </div>
      {isExpanded && <EpicDetail epicId={epic.id} />}
    </div>
  );
}

function EpicDetail({ epicId }: { epicId: string }) {
  const { data, isLoading } = useEpic(epicId);

  if (isLoading) return <div className="px-4 py-3 text-sm text-muted-foreground border-t border-border">Loading...</div>;
  if (!data) return null;

  const workItems: WorkItem[] = data.workItems ?? [];

  return (
    <div className="border-t border-border bg-muted/20">
      {data.description && (
        <div className="px-4 py-2 text-sm text-muted-foreground border-b border-border">{data.description}</div>
      )}
      {workItems.length === 0 ? (
        <div className="px-4 py-3 text-sm text-muted-foreground">No work items in this epic.</div>
      ) : (
        <div className="divide-y divide-border">
          {workItems.map((item) => (
            <WorkItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkItemRow({ item }: { item: WorkItem }) {
  return (
    <Link to={`/work-items/${item.id}`} className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent/50 transition-colors">
      <KindIcon kind={item.kind} size={14} />
      <span className="flex-1 truncate">{item.title}</span>
      <StatusBadge status={item.status} />
    </Link>
  );
}
