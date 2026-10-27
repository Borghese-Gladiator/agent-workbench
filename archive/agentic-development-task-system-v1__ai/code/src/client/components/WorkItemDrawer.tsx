import { Link } from 'react-router-dom';
import { useWorkItem, useUpdateWorkItem } from '@client/services/hooks';
import { StatusBadge } from '@client/components/StatusBadge';
import { KindIcon } from '@client/components/KindIcon';
import { InlineTextField } from '@client/components/ui/InlineTextField';
import { timeAgo } from '@client/utils/time';
import { X, BellOff } from 'lucide-react';
import { Button } from '@client/components/ui/button';
import { Separator } from '@client/components/ui/separator';
import { CommentList } from '@client/components/CommentList';
import { useToast } from '@client/components/Toast';

function awaitingFlag(raw: Record<string, unknown>): boolean {
  if (typeof raw.awaiting_input === 'number') return raw.awaiting_input !== 0;
  if (typeof raw.awaiting_input === 'boolean') return raw.awaiting_input;
  return !!raw.awaitingInput;
}

export function WorkItemDrawer({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const { data: item, isLoading } = useWorkItem(itemId);
  const updateMutation = useUpdateWorkItem();
  const { toast } = useToast();

  function saveField(field: 'title' | 'body' | 'acceptance_criteria', value: string) {
    const patch = { id: itemId, [field]: value.length > 0 ? value : null } as Parameters<
      typeof updateMutation.mutate
    >[0];
    updateMutation.mutate(patch, {
      onSuccess: () => toast('Saved', 'success'),
      onError: (err) => toast(`Failed: ${(err as Error).message}`, 'error'),
    });
  }

  function clearAwaiting() {
    updateMutation.mutate(
      { id: itemId, awaiting_input: 0 },
      {
        onSuccess: () => toast('Cleared awaiting flag', 'success'),
        onError: (err) => toast(`Failed: ${(err as Error).message}`, 'error'),
      },
    );
  }

  const itemAny = (item ?? {}) as unknown as Record<string, unknown>;
  const isAwaiting = item ? awaitingFlag(itemAny) : false;
  const activeSessionId =
    (item?.activeSessionId ?? (itemAny.active_session_id as string | null)) || null;
  const body = item?.body ?? '';
  const acceptance =
    item?.acceptanceCriteria ?? (itemAny.acceptance_criteria as string | null) ?? '';
  const epicData = (itemAny.epic ?? null) as { id: string; title: string } | null;
  const assignedAgentId =
    item?.assignedAgentId ?? (itemAny.assigned_agent_id as string | null);
  const reviewerAgentId =
    item?.reviewerAgentId ?? (itemAny.reviewer_agent_id as string | null);
  const updatedAt = item?.updatedAt ?? (itemAny.updated_at as string | undefined);
  const createdAt = item?.createdAt ?? (itemAny.created_at as string | undefined);
  const dependsOnId =
    item?.dependsOnId ?? (itemAny.depends_on_id as string | null);
  const blockedByTitle =
    item?.blockedByTitle ?? (itemAny.blocked_by_title as string | null);
  const readyToStart = item?.readyToStart ?? Boolean(itemAny.ready_to_start);
  const batchId = item?.batchId ?? (itemAny.batch_id as string | null);

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[480px] border-l border-border bg-background shadow-xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-end px-6 py-4 border-b border-border">
        <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && <div className="text-muted-foreground">Loading...</div>}
        {item && (
          <div className="space-y-5">
            {/* Awaiting banner */}
            {isAwaiting && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                <div className="flex items-center gap-2 text-sm text-amber-200">
                  <span className="size-1.5 rounded-full bg-amber-400 animate-pulse" />
                  Claude is awaiting input
                </div>
                <button
                  type="button"
                  onClick={clearAwaiting}
                  className="flex items-center gap-1.5 text-xs text-amber-200 hover:text-amber-100"
                >
                  <BellOff className="size-3.5" /> Clear
                </button>
              </div>
            )}

            {/* Title — inline-editable */}
            <div className="flex items-start gap-2">
              <KindIcon kind={item.kind} className="mt-1 shrink-0" />
              <div className="flex-1 min-w-0">
                <InlineTextField
                  value={item.title}
                  onSave={(next) => saveField('title', next)}
                  ariaLabel="Edit title"
                  className="text-lg font-semibold block"
                />
                <Link
                  to={`/work-items/${itemId}`}
                  className="text-xs text-muted-foreground hover:text-blue-400 transition-colors"
                >
                  Open full detail →
                </Link>
              </div>
            </div>

            {/* Status + kind */}
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={item.status} />
              <StatusBadge status={item.kind} />
            </div>

            {/* Epic link */}
            {epicData && (
              <div>
                <span className="text-xs text-muted-foreground">Epic</span>
                <Link
                  to={`/epics/${epicData.id}`}
                  className="block text-sm text-blue-400 hover:text-blue-300 transition-colors"
                >
                  {epicData.title}
                </Link>
              </div>
            )}

            {/* Meta */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Assigned</span>
                <p>{assignedAgentId ?? 'Unassigned'}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Reviewer</span>
                <p>{reviewerAgentId ?? 'None'}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Updated</span>
                <p>{updatedAt ? timeAgo(updatedAt) : '—'}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Created</span>
                <p>{createdAt ? timeAgo(createdAt) : '—'}</p>
              </div>
              {item.lane && (
                <div>
                  <span className="text-muted-foreground">Lane</span>
                  <p className="uppercase tracking-wide text-xs">{item.lane}</p>
                </div>
              )}
              {dependsOnId && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">Depends on</span>
                  <p className={readyToStart ? 'text-emerald-400' : 'text-muted-foreground'}>
                    {blockedByTitle ?? dependsOnId.slice(0, 8)}
                    {readyToStart ? ' · ready' : ' · waiting'}
                  </p>
                </div>
              )}
              {batchId && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">Batch</span>
                  <p className="font-mono text-xs truncate">{batchId}</p>
                </div>
              )}
            </div>

            {/* Tags */}
            {item.tags && item.tags.length > 0 && (
              <>
                <Separator />
                <div>
                  <h3 className="text-sm font-medium mb-2">Tags</h3>
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusBadge status={item.kind} />
                    <span className="mx-1 text-border">|</span>
                    {[...item.tags].sort().map((tag) => (
                      <span key={tag} className="text-xs bg-muted px-2 py-0.5 rounded">{tag}</span>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Body — inline-editable */}
            <Separator />
            <div>
              <h3 className="text-sm font-medium mb-2">Description</h3>
              <InlineTextField
                value={body}
                onSave={(next) => saveField('body', next)}
                multiline
                allowEmpty
                placeholder="Click to add a description…"
                ariaLabel="Edit description"
                className="text-sm text-muted-foreground whitespace-pre-wrap block"
              />
            </div>

            {/* Acceptance criteria */}
            <Separator />
            <div>
              <h3 className="text-sm font-medium mb-2">Acceptance criteria</h3>
              <InlineTextField
                value={acceptance}
                onSave={(next) => saveField('acceptance_criteria', next)}
                multiline
                allowEmpty
                placeholder="Click to add acceptance criteria…"
                ariaLabel="Edit acceptance criteria"
                className="text-sm text-muted-foreground whitespace-pre-wrap block"
              />
            </div>

            {/* Sub-items */}
            {item.subItems && item.subItems.length > 0 && (
              <>
                <Separator />
                <div>
                  <h3 className="text-sm font-medium mb-2">Sub-tasks ({item.subItems.length})</h3>
                  <div className="space-y-1">
                    {item.subItems.map((sub) => (
                      <div key={sub.id} className="flex items-center gap-2 text-sm py-1">
                        <KindIcon kind={sub.kind} size={14} />
                        <span className="flex-1 truncate">{sub.title}</span>
                        <StatusBadge status={sub.status} />
                      </div>
                    ))}
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
                  {(item.reviews as Array<{ id: string; outcome: string; summary?: string }>).map((r) => (
                    <div key={r.id} className="text-sm border border-border rounded p-2 mb-1">
                      <StatusBadge status={r.outcome} />
                      {r.summary && <p className="text-xs text-muted-foreground mt-1">{r.summary}</p>}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Comments */}
            <Separator />
            <CommentList workItemId={itemId} compact activeSessionId={activeSessionId} />
          </div>
        )}
      </div>
    </div>
  );
}
