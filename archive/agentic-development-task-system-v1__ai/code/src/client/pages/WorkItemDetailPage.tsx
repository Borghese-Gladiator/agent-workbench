import { useState, useRef, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useWorkItem, useUpdateWorkItem, useCreateSession } from '@client/services/hooks';
import { StatusBadge } from '@client/components/StatusBadge';
import { KindIcon } from '@client/components/KindIcon';
import { timeAgo } from '@client/utils/time';
import { Separator } from '@client/components/ui/separator';
import { Input } from '@client/components/ui/input';
import { Button } from '@client/components/ui/button';
import { CommentList } from '@client/components/CommentList';
import { ArrowLeft, FileText, Layers, Terminal, Play } from 'lucide-react';
import type { Artifact, TerminalSession } from '@shared/types';

const CATEGORY_BORDER: Record<string, string> = {
  work: 'border-l-blue-500',
  personal: 'border-l-green-500',
};

export function WorkItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: item, isLoading, error } = useWorkItem(id ?? '');
  const createSession = useCreateSession();

  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (error) return <div className="p-6 text-destructive">Error: {(error as Error).message}</div>;
  if (!item) return <div className="p-6 text-muted-foreground">Not found.</div>;

  const plans = (item.artifacts ?? []).filter((a: Artifact) =>
    a.artifactType === 'note' || (a.artifactType === 'file' && a.path?.endsWith('.md'))
  );

  const epic = (item as any).epic as { id: string; title: string; color: string } | null;
  const parent = (item as any).parent as { id: string; title: string; kind: string } | null;
  const category = (item as any).category as string ?? 'work';
  const sortedTags = [...(item.tags ?? [])].sort();
  const borderClass = CATEGORY_BORDER[category] ?? CATEGORY_BORDER.work;

  return (
    <div className="h-full overflow-y-auto">
      <div className={`max-w-3xl mx-auto p-6 space-y-6 border-l-4 ${borderClass}`}>
        {/* Navigation — epic link for tasks, parent link for subtasks */}
        {parent ? (
          <Link to={`/work-items/${parent.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" />
            <KindIcon kind={parent.kind} size={14} />
            {parent.title}
          </Link>
        ) : epic ? (
          <Link to={`/epics/${epic.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" />
            <Layers className="size-3.5" />
            {epic.title}
          </Link>
        ) : (
          <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Board
          </Link>
        )}

        {/* Title — click to inline edit */}
        <InlineEditTitle itemId={item.id} title={item.title} kind={item.kind} />

        {/* Status row */}
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={item.status} />
          <StatusBadge status={item.kind} />
        </div>

        {/* Terminal session link or start button */}
        {item.activeSessionId ? (
          <Link
            to={`/terminal?session=${item.activeSessionId}`}
            className="inline-flex items-center gap-2 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            <Terminal className="size-4" />
            View Terminal Session
          </Link>
        ) : item.status === 'in_progress' ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => {
              createSession.mutate(item.id, {
                onSuccess: (session: TerminalSession) => {
                  navigate(`/terminal?session=${session.id}`);
                },
              });
            }}
            disabled={createSession.isPending}
          >
            <Play className="size-3" />
            {createSession.isPending ? 'Starting...' : 'Start Session'}
          </Button>
        ) : null}

        {/* Epic link (shown separately when item has a parent too) */}
        {parent && epic && (
          <div>
            <span className="text-xs text-muted-foreground block mb-0.5">Epic</span>
            <Link to={`/epics/${epic.id}`} className="text-sm text-blue-400 hover:text-blue-300 transition-colors">
              {epic.title}
            </Link>
          </div>
        )}

        {/* Meta grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground block text-xs mb-0.5">Assigned</span>
            <p>{item.assignedAgentId ?? 'Unassigned'}</p>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs mb-0.5">Reviewer</span>
            <p>{item.reviewerAgentId ?? 'None'}</p>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs mb-0.5">Updated</span>
            <p>{timeAgo(item.updatedAt)}</p>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs mb-0.5">Created</span>
            <p>{timeAgo(item.createdAt)}</p>
          </div>
        </div>

        {/* Tags: kind first, then category, then separator, then sorted tags */}
        <Separator />
        <div>
          <h3 className="text-sm font-medium mb-2">Tags</h3>
          <div className="flex flex-wrap items-center gap-1">
            <StatusBadge status={item.kind} />
            <span className={`text-xs px-2 py-0.5 rounded border ${category === 'personal' ? 'border-green-500/40 text-green-500 bg-green-500/10' : 'border-blue-500/40 text-blue-500 bg-blue-500/10'}`}>
              {category}
            </span>
            {sortedTags.length > 0 && (
              <>
                <span className="mx-1 text-border">|</span>
                {sortedTags.map((tag) => (
                  <span key={tag} className="text-xs bg-muted px-2 py-1 rounded">{tag}</span>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Description */}
        {item.body && (
          <>
            <Separator />
            <div>
              <h3 className="text-sm font-medium mb-2">Description</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{item.body}</p>
            </div>
          </>
        )}

        {/* Acceptance Criteria */}
        {item.acceptanceCriteria && (
          <>
            <Separator />
            <div>
              <h3 className="text-sm font-medium mb-2">Acceptance Criteria</h3>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{item.acceptanceCriteria}</p>
            </div>
          </>
        )}

        {/* Sub-tasks */}
        {item.subItems && item.subItems.length > 0 && (
          <>
            <Separator />
            <div>
              <h3 className="text-sm font-medium mb-2">Sub-tasks ({item.subItems.length})</h3>
              <div className="space-y-1">
                {item.subItems.map((sub) => (
                  <Link key={sub.id} to={`/work-items/${sub.id}`} className="flex items-center gap-2 text-sm py-1.5 px-2 rounded hover:bg-accent/50">
                    <KindIcon kind={sub.kind} size={14} />
                    <span className="flex-1 truncate">{sub.title}</span>
                    <StatusBadge status={sub.status} />
                  </Link>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Plans / Artifacts */}
        {plans.length > 0 && (
          <>
            <Separator />
            <div>
              <h3 className="text-sm font-medium mb-2">Plans ({plans.length})</h3>
              <div className="space-y-3">
                {plans.map((plan: Artifact) => {
                  let content = '';
                  if (plan.metadataJson) {
                    try { content = JSON.parse(plan.metadataJson).content ?? ''; } catch { /* ignore */ }
                  }
                  return (
                    <div key={plan.id} className="border border-border rounded-lg overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border">
                        <FileText className="size-4 text-muted-foreground" />
                        <span className="text-sm font-medium">{plan.title ?? plan.path ?? 'Plan'}</span>
                      </div>
                      {content ? (
                        <pre className="p-4 text-sm whitespace-pre-wrap overflow-x-auto">{content}</pre>
                      ) : (
                        <p className="p-4 text-sm text-muted-foreground">No content available.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Reviews */}
        {item.reviews && item.reviews.length > 0 && (
          <>
            <Separator />
            <div>
              <h3 className="text-sm font-medium mb-2">Reviews ({item.reviews.length})</h3>
              {(item.reviews as Array<{ id: string; outcome: string; summary?: string; reviewType?: string }>).map((r) => (
                <div key={r.id} className="border border-border rounded p-3 mb-2">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusBadge status={r.outcome} />
                    {r.reviewType && <span className="text-xs text-muted-foreground">{r.reviewType}</span>}
                  </div>
                  {r.summary && <p className="text-sm text-muted-foreground">{r.summary}</p>}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Comments */}
        <Separator />
        <CommentList workItemId={item.id} activeSessionId={item.activeSessionId ?? null} />
      </div>
    </div>
  );
}

function InlineEditTitle({ itemId, title, kind }: { itemId: string; title: string; kind: string }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const updateWorkItem = useUpdateWorkItem();

  useEffect(() => {
    if (isEditing && inputRef.current) inputRef.current.focus();
  }, [isEditing]);

  useEffect(() => {
    setEditValue(title);
  }, [title]);

  function handleSave() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) {
      updateWorkItem.mutate({ id: itemId, title: trimmed });
    }
    setIsEditing(false);
  }

  if (isEditing) {
    return (
      <div className="flex items-start gap-3">
        <KindIcon kind={kind} size={24} className="mt-2 shrink-0" />
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
      <KindIcon kind={kind} size={24} className="mt-1 shrink-0" />
      <h1 className="text-2xl font-bold group-hover:underline decoration-dashed underline-offset-4 decoration-muted-foreground">{title}</h1>
    </div>
  );
}
