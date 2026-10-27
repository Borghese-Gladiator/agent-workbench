import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useEpics, useWorkItems, useWorkItem } from '@client/services/hooks';
import { StatusBadge } from '@client/components/StatusBadge';
import { KindIcon } from '@client/components/KindIcon';
import { ChevronDown, ChevronRight, Layers, FileText } from 'lucide-react';
import type { Artifact } from '@shared/types';

type TreeSelection =
  | { type: 'work_item'; id: string }
  | { type: 'artifact'; workItemId: string; artifactId: string }
  | null;

export function LibraryPage() {
  const { data: epics, isLoading } = useEpics();
  const { data: allItems } = useWorkItems();
  const [selection, setSelection] = useState<TreeSelection>(null);
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // Group items by epic
  const itemsByEpic = useMemo(() => {
    const map = new Map<string | null, typeof allItems>();
    for (const item of allItems ?? []) {
      const key = item.epicId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [allItems]);

  function toggleEpic(epicId: string) {
    setExpandedEpics((prev) => {
      const next = new Set(prev);
      if (next.has(epicId)) next.delete(epicId);
      else next.add(epicId);
      return next;
    });
  }

  function toggleItem(itemId: string) {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  const epicList = epics ?? [];
  const ungroupedItems = itemsByEpic.get(null) ?? [];

  return (
    <div className="h-full flex flex-col">
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur px-6 py-4">
        <h2 className="text-xl font-semibold">Tasks</h2>
        <p className="text-sm text-muted-foreground">Browse epics, work items, and plans</p>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Tree panel */}
        <div className="w-80 border-r border-border overflow-y-auto p-3 shrink-0">
          {epicList.length === 0 && ungroupedItems.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Layers className="mx-auto size-8 mb-2 opacity-40" />
              <p className="text-sm">No epics or items yet.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {epicList.map((epic) => {
                const items = itemsByEpic.get(epic.id) ?? [];
                const isExpanded = expandedEpics.has(epic.id);
                return (
                  <div key={epic.id}>
                    <button
                      className="flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-accent/50 text-left text-sm"
                      onClick={() => toggleEpic(epic.id)}
                    >
                      {isExpanded ? <ChevronDown className="size-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />}
                      <Layers className="size-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate font-medium">{epic.title}</span>
                      <span className="ml-auto text-xs text-muted-foreground shrink-0">{items.length}</span>
                    </button>
                    {isExpanded && items.length > 0 && (
                      <div className="ml-5 space-y-0.5">
                        {items.map((item) => (
                          <TreeWorkItem
                            key={item.id}
                            item={item}
                            isExpanded={expandedItems.has(item.id)}
                            isSelected={selection?.type === 'work_item' && selection.id === item.id}
                            selectedArtifactId={selection?.type === 'artifact' && selection.workItemId === item.id ? selection.artifactId : null}
                            onToggle={() => toggleItem(item.id)}
                            onSelect={() => setSelection({ type: 'work_item', id: item.id })}
                            onSelectArtifact={(aid) => setSelection({ type: 'artifact', workItemId: item.id, artifactId: aid })}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {ungroupedItems.length > 0 && (
                <div>
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide mt-3">
                    Ungrouped
                  </div>
                  <div className="space-y-0.5">
                    {ungroupedItems.map((item) => (
                      <TreeWorkItem
                        key={item.id}
                        item={item}
                        isExpanded={expandedItems.has(item.id)}
                        isSelected={selection?.type === 'work_item' && selection.id === item.id}
                        selectedArtifactId={selection?.type === 'artifact' && selection.workItemId === item.id ? selection.artifactId : null}
                        onToggle={() => toggleItem(item.id)}
                        onSelect={() => setSelection({ type: 'work_item', id: item.id })}
                        onSelectArtifact={(aid) => setSelection({ type: 'artifact', workItemId: item.id, artifactId: aid })}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Preview panel */}
        <div className="flex-1 overflow-y-auto p-6">
          {!selection ? (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="mx-auto size-10 mb-3 opacity-40" />
              <p className="text-sm">Select an item or plan from the tree to preview it.</p>
            </div>
          ) : selection.type === 'work_item' ? (
            <WorkItemPreview itemId={selection.id} />
          ) : (
            <ArtifactPreview workItemId={selection.workItemId} artifactId={selection.artifactId} />
          )}
        </div>
      </div>
    </div>
  );
}

function TreeWorkItem({ item, isExpanded, isSelected, selectedArtifactId, onToggle, onSelect, onSelectArtifact }: {
  item: { id: string; kind: string; title: string };
  isExpanded: boolean;
  isSelected: boolean;
  selectedArtifactId: string | null;
  onToggle: () => void;
  onSelect: () => void;
  onSelectArtifact: (id: string) => void;
}) {
  const { data } = useWorkItem(item.id);
  const hasPlans = useMemo(() => {
    if (!data?.artifacts) return false;
    return data.artifacts.some((a: Artifact) =>
      a.artifactType === 'note' || (a.artifactType === 'file' && a.path?.endsWith('.md'))
    );
  }, [data?.artifacts]);

  return (
    <div>
      <div className="flex items-center gap-1">
        {hasPlans ? (
          <button className="p-0.5 rounded hover:bg-accent/50" onClick={onToggle}>
            {isExpanded ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <button
          className={`flex items-center gap-1.5 flex-1 min-w-0 px-1.5 py-1 rounded text-sm text-left ${isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}`}
          onClick={onSelect}
        >
          <KindIcon kind={item.kind} size={13} className="shrink-0" />
          <span className="truncate">{item.title}</span>
        </button>
      </div>
      {isExpanded && hasPlans && <TreeItemPlans workItemId={item.id} selectedArtifactId={selectedArtifactId} onSelectArtifact={onSelectArtifact} />}
    </div>
  );
}

function TreeItemPlans({ workItemId, selectedArtifactId, onSelectArtifact }: {
  workItemId: string; selectedArtifactId: string | null; onSelectArtifact: (id: string) => void;
}) {
  const { data } = useWorkItem(workItemId);
  const plans = useMemo(() => {
    if (!data?.artifacts) return [];
    return data.artifacts.filter((a: Artifact) =>
      a.artifactType === 'note' || (a.artifactType === 'file' && a.path?.endsWith('.md'))
    );
  }, [data?.artifacts]);

  if (plans.length === 0) return null;

  return (
    <div className="ml-7 space-y-0.5">
      {plans.map((plan: Artifact) => (
        <button
          key={plan.id}
          className={`flex items-center gap-1.5 w-full px-1.5 py-1 rounded text-xs text-left ${selectedArtifactId === plan.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}
          onClick={() => onSelectArtifact(plan.id)}
        >
          <FileText className="size-3 shrink-0" />
          <span className="truncate">{plan.title ?? plan.path ?? 'Plan'}</span>
        </button>
      ))}
    </div>
  );
}

function WorkItemPreview({ itemId }: { itemId: string }) {
  const { data: item, isLoading } = useWorkItem(itemId);

  if (isLoading) return <div className="text-muted-foreground">Loading...</div>;
  if (!item) return null;

  const plans = (item.artifacts ?? []).filter((a: Artifact) =>
    a.artifactType === 'note' || (a.artifactType === 'file' && a.path?.endsWith('.md'))
  );

  return (
    <div className="space-y-4">
      <Link to={`/work-items/${item.id}`} className="flex items-start gap-2 hover:text-blue-400 transition-colors">
        <KindIcon kind={item.kind} className="mt-1 shrink-0" />
        <h2 className="text-lg font-semibold">{item.title}</h2>
      </Link>

      <div className="flex items-center gap-2">
        <StatusBadge status={item.status} />
        <StatusBadge status={item.kind} />
      </div>

      {item.body && (
        <div>
          <h3 className="text-sm font-medium mb-1">Description</h3>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{item.body}</p>
        </div>
      )}

      {item.acceptanceCriteria && (
        <div>
          <h3 className="text-sm font-medium mb-1">Acceptance Criteria</h3>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{item.acceptanceCriteria}</p>
        </div>
      )}

      {item.tags && item.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {item.tags.map((tag) => (
            <span key={tag} className="text-xs bg-muted px-2 py-0.5 rounded">{tag}</span>
          ))}
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium mb-2">Plans ({plans.length})</h3>
        {plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plans generated for this item.</p>
        ) : (
          <div className="space-y-1">
            {plans.map((plan: Artifact) => (
              <div key={plan.id} className="flex items-center gap-2 text-sm border border-border rounded p-2">
                <FileText className="size-4 text-muted-foreground" />
                <span>{plan.title ?? plan.path ?? 'Plan'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactPreview({ workItemId, artifactId }: { workItemId: string; artifactId: string }) {
  const { data } = useWorkItem(workItemId);
  const artifact = useMemo(() => {
    if (!data?.artifacts) return null;
    return data.artifacts.find((a: Artifact) => a.id === artifactId) ?? null;
  }, [data?.artifacts, artifactId]);

  if (!artifact) return <div className="text-muted-foreground">Loading...</div>;

  // Try to extract markdown content from metadata_json
  let content = '';
  if (artifact.metadataJson) {
    try {
      const meta = JSON.parse(artifact.metadataJson);
      content = meta.content ?? '';
    } catch { /* ignore */ }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <FileText className="size-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{artifact.title ?? artifact.path ?? 'Plan'}</h2>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge status={artifact.artifactType} />
        {artifact.path && <span className="font-mono">{artifact.path}</span>}
      </div>
      {content ? (
        <div className="prose prose-sm prose-invert max-w-none">
          <pre className="whitespace-pre-wrap text-sm bg-muted/30 rounded-lg p-4 border border-border">{content}</pre>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No content available for this artifact.</p>
      )}
    </div>
  );
}
