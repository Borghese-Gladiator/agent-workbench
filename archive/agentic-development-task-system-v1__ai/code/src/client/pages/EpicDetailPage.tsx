import { useState, useRef, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useEpic, useUpdateEpic } from '@client/services/hooks';
import { StatusBadge } from '@client/components/StatusBadge';
import { KindIcon } from '@client/components/KindIcon';
import { timeAgo } from '@client/utils/time';
import { Separator } from '@client/components/ui/separator';
import { Input } from '@client/components/ui/input';
import { ArrowLeft, Layers } from 'lucide-react';
import type { WorkItem } from '@shared/types';
import { epicColorToCss } from '@client/utils/colors';

export function EpicDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: epic, isLoading, error } = useEpic(id ?? '');

  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (error) return <div className="p-6 text-destructive">Error: {(error as Error).message}</div>;
  if (!epic) return <div className="p-6 text-muted-foreground">Not found.</div>;

  const workItems: WorkItem[] = (epic as any).workItems ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        {/* Back link */}
        <Link to="/epics" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Back to epics
        </Link>

        {/* Title — click to inline edit */}
        <InlineEditEpicTitle epicId={epic.id} title={epic.title} />

        {/* Status + color */}
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={epic.status} />
          <span className="text-xs px-2 py-0.5 rounded border" style={{ borderColor: epicColorToCss((epic as any).color) }}>
            {(epic as any).color ?? 'blue'}
          </span>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground block text-xs mb-0.5">Updated</span>
            <p>{timeAgo(epic.updatedAt)}</p>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs mb-0.5">Created</span>
            <p>{timeAgo(epic.createdAt)}</p>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs mb-0.5">Work items</span>
            <p>{workItems.length}</p>
          </div>
        </div>

        {/* Description */}
        {epic.description && (
          <>
            <Separator />
            <div>
              <h3 className="text-sm font-medium mb-2">Description</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{epic.description}</p>
            </div>
          </>
        )}

        {/* Work Items */}
        {workItems.length > 0 && (
          <>
            <Separator />
            <div>
              <h3 className="text-sm font-medium mb-2">Work Items ({workItems.length})</h3>
              <div className="space-y-1">
                {workItems.map((item) => (
                  <Link key={item.id} to={`/work-items/${item.id}`} className="flex items-center gap-2 text-sm py-1.5 px-2 rounded hover:bg-accent/50">
                    <KindIcon kind={item.kind} size={14} />
                    <span className="flex-1 truncate">{item.title}</span>
                    <StatusBadge status={item.status} />
                  </Link>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InlineEditEpicTitle({ epicId, title }: { epicId: string; title: string }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const updateEpic = useUpdateEpic();

  useEffect(() => {
    if (isEditing && inputRef.current) inputRef.current.focus();
  }, [isEditing]);

  useEffect(() => {
    setEditValue(title);
  }, [title]);

  function handleSave() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) {
      updateEpic.mutate({ id: epicId, title: trimmed });
    }
    setIsEditing(false);
  }

  if (isEditing) {
    return (
      <div className="flex items-start gap-3">
        <Layers size={24} className="mt-2 shrink-0 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') { setEditValue(title); setIsEditing(false); }
          }}
          className="text-2xl font-bold h-auto py-1"
        />
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 group cursor-text" onClick={() => setIsEditing(true)}>
      <Layers size={24} className="mt-1 shrink-0 text-muted-foreground" />
      <h1 className="text-2xl font-bold group-hover:underline decoration-dashed underline-offset-4 decoration-muted-foreground">{title}</h1>
    </div>
  );
}

