import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useWorkItems, useTags, useEpics, useTransitionWorkItem, useReorderWorkItems, useUpdateWorkItem } from '@client/services/hooks';
import { InlineTextField } from '@client/components/ui/InlineTextField';
import { useCommandPalette } from '@client/components/CommandPalette';
import { Switch } from '@client/components/ui/switch';
import { Label } from '@client/components/ui/label';
import { useToast } from '@client/components/Toast';
import { StatusBadge } from '@client/components/StatusBadge';
import { KindIcon } from '@client/components/KindIcon';
import { WorkItemDrawer } from '@client/components/WorkItemDrawer';
import { timeAgo } from '@client/utils/time';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@client/components/ui/select';
import { Button } from '@client/components/ui/button';
import { User, Clock, ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import type { WorkItem } from '@shared/types';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  useSensor,
  useSensors,
  PointerSensor,
  KeyboardSensor,
  useDroppable,
} from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type KanbanColumnDef = { label: string; statuses: string[] };

const COLUMNS: KanbanColumnDef[] = [
  { label: 'Triage', statuses: ['triage'] },
  { label: 'Ready', statuses: ['ready'] },
  { label: 'In Progress', statuses: ['in_progress'] },
  { label: 'Review', statuses: ['in_review'] },
  { label: 'Done', statuses: ['done'] },
];

const COLUMN_DEFAULT_STATUS: Record<string, string> = {
  Triage: 'triage',
  Ready: 'ready',
  'In Progress': 'in_progress',
  Review: 'in_review',
  Done: 'done',
};

const STATUS_DOT_COLORS: Record<string, string> = {
  Triage: 'bg-gray-500',
  Ready: 'bg-cyan-500',
  'In Progress': 'bg-blue-500',
  Review: 'bg-purple-500',
  Done: 'bg-emerald-500',
};

type GroupedColumn = KanbanColumnDef & { items: WorkItem[] };

// Stable-ish hash-to-palette for lanes. Names with the same characters map to
// the same color across renders and reloads; no config needed.
const LANE_PALETTE = [
  'border-l-sky-500',
  'border-l-violet-500',
  'border-l-amber-500',
  'border-l-rose-500',
  'border-l-emerald-500',
  'border-l-orange-500',
  'border-l-fuchsia-500',
  'border-l-teal-500',
];

function laneBorderClass(lane: string | null | undefined): string | null {
  if (!lane) return null;
  let hash = 0;
  for (let i = 0; i < lane.length; i++) hash = (hash * 31 + lane.charCodeAt(i)) | 0;
  return LANE_PALETTE[Math.abs(hash) % LANE_PALETTE.length];
}

function findColumnForItem(itemId: string, grouped: GroupedColumn[]): string | null {
  for (const col of grouped) {
    if (col.items.some((i) => i.id === itemId)) return col.label;
  }
  return null;
}

function groupItemsIntoColumns(itemList: WorkItem[]): GroupedColumn[] {
  // Server already sorts by (sort_order, created_at, id); keep that order.
  return COLUMNS.map((col) => ({
    ...col,
    items: itemList.filter((i) => col.statuses.includes(i.status)),
  }));
}

// Server returns snake_case (awaiting_input: 0 | 1); client type is camelCase
// (awaitingInput: boolean). Support both.
function isAwaiting(item: WorkItem): boolean {
  const raw = item as unknown as Record<string, unknown>;
  if (typeof raw.awaiting_input === 'number') return raw.awaiting_input !== 0;
  if (typeof raw.awaiting_input === 'boolean') return raw.awaiting_input;
  return !!item.awaitingInput;
}

const ALL_VALUE = '__all__';

export function BoardPage() {
  const [kindFilter, setKindFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [laneFilter, setLaneFilter] = useState('');
  const [groupBy, setGroupBy] = useState<'none' | 'epic'>('epic');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [collapsedEpics, setCollapsedEpics] = useState<Set<string>>(new Set());
  const updateMutation = useUpdateWorkItem();
  const palette = useCommandPalette();

  const filters: Record<string, string | undefined> = {
    kind: kindFilter || undefined,
    tag: tagFilter || undefined,
    lane: laneFilter || undefined,
  };
  const hasFilters = Object.values(filters).some(Boolean);

  const { data: items, isLoading, error } = useWorkItems(
    hasFilters
      ? {
          kind: kindFilter || undefined,
          tag: tagFilter || undefined,
          lane: laneFilter || undefined,
        }
      : undefined,
  );
  const { data: allTags } = useTags();
  const { data: epics } = useEpics();

  const { toast } = useToast();
  const transitionMutation = useTransitionWorkItem();
  const reorderMutation = useReorderWorkItems();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const itemList = items ?? [];

  // Build epic lookup for display
  const epicMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of epics ?? []) m.set(e.id, e.title);
    return m;
  }, [epics]);

  // Epic sort_order lookup (for deterministic group ordering)
  const epicSortMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of epics ?? []) m.set(e.id, e.sortOrder ?? 0);
    return m;
  }, [epics]);

  // Distinct lane values currently present on the board.
  const allLanes = useMemo(() => {
    const s = new Set<string>();
    for (const i of itemList) if (i.lane) s.add(i.lane);
    return Array.from(s).sort();
  }, [itemList]);

  // Group by epic if toggled
  const epicGroups = useMemo(() => {
    if (groupBy !== 'epic') return null;
    const groups = new Map<string | null, WorkItem[]>();
    for (const item of itemList) {
      const key = item.epicId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    // Sort: named epics by sort_order then title; ungrouped last.
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      const sortA = epicSortMap.get(a) ?? 0;
      const sortB = epicSortMap.get(b) ?? 0;
      if (sortA !== sortB) return sortA - sortB;
      return (epicMap.get(a) ?? '').localeCompare(epicMap.get(b) ?? '');
    });
  }, [groupBy, itemList, epicMap, epicSortMap]);

  const flatGrouped: GroupedColumn[] = useMemo(() => groupItemsIntoColumns(itemList), [itemList]);

  const activeItem = activeId ? itemList.find((i) => i.id === activeId) ?? null : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const activeItemId = active.id as string;
    const allGrouped = groupBy === 'epic' ? groupItemsIntoColumns(itemList) : flatGrouped;
    const activeColumn = findColumnForItem(activeItemId, allGrouped);

    let targetColumn: string | null = null;
    if (String(over.id).startsWith('column-')) {
      targetColumn = String(over.id).replace(/^column-[^-]*-?/, '').replace(/^column-/, '') || String(over.id).replace('column-', '');
      // Extract just the column label
      for (const col of COLUMNS) {
        if (String(over.id).endsWith(col.label)) { targetColumn = col.label; break; }
      }
    } else {
      targetColumn = findColumnForItem(String(over.id), allGrouped);
    }

    if (!activeColumn || !targetColumn) return;

    if (activeColumn !== targetColumn) {
      const newStatus = COLUMN_DEFAULT_STATUS[targetColumn];
      if (!newStatus) { toast(`Cannot move items to "${targetColumn}"`, 'error'); return; }
      const item = itemList.find((i) => i.id === activeItemId);
      const title = item?.title ?? 'Item';
      toast(`Moving "${title}" to ${targetColumn}...`, 'info');
      transitionMutation.mutate(
        { id: activeItemId, status: newStatus },
        {
          onSuccess: () => toast(`Moved "${title}" to ${targetColumn}`, 'success'),
          onError: (err) => toast(`Failed: ${(err as Error).message}`, 'error'),
        },
      );
    } else {
      const colItems = allGrouped.find((c) => c.label === activeColumn)?.items ?? [];
      const oldIndex = colItems.findIndex((i) => i.id === activeItemId);
      const newIndex = colItems.findIndex((i) => i.id === String(over.id));
      if (oldIndex !== newIndex && newIndex >= 0) {
        const reordered = arrayMove(colItems, oldIndex, newIndex);
        reorderMutation.mutate(reordered.map((i, idx) => ({ work_item_id: i.id, sort_order: idx })));
      }
    }
  }

  function handleCardClick(id: string) {
    setSelectedItemId(id);
    setSelectedCardId(id);
  }

  // ── Keyboard navigation ───────────────────────────────────────────────────
  const groupedForNav = useMemo(() => groupItemsIntoColumns(itemList), [itemList]);

  const moveSelection = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right') => {
      if (itemList.length === 0) return;
      const columns = groupedForNav;
      const current = selectedCardId;
      if (!current) {
        const first = columns.find((c) => c.items.length > 0)?.items[0];
        if (first) setSelectedCardId(first.id);
        return;
      }
      const colIdx = columns.findIndex((c) => c.items.some((i) => i.id === current));
      if (colIdx < 0) return;
      const rowIdx = columns[colIdx].items.findIndex((i) => i.id === current);

      if (direction === 'up' || direction === 'down') {
        const next = columns[colIdx].items[rowIdx + (direction === 'down' ? 1 : -1)];
        if (next) setSelectedCardId(next.id);
      } else {
        const delta = direction === 'right' ? 1 : -1;
        for (let i = colIdx + delta; i >= 0 && i < columns.length; i += delta) {
          const col = columns[i];
          if (col.items.length === 0) continue;
          const clamped = Math.min(rowIdx, col.items.length - 1);
          setSelectedCardId(col.items[clamped].id);
          return;
        }
      }
    },
    [itemList, selectedCardId, groupedForNav],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;
      if (inInput) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          moveSelection('down');
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          moveSelection('up');
          break;
        case 'h':
        case 'ArrowLeft':
          e.preventDefault();
          moveSelection('left');
          break;
        case 'l':
        case 'ArrowRight':
          e.preventDefault();
          moveSelection('right');
          break;
        case 'Enter':
          if (selectedCardId) {
            e.preventDefault();
            setEditingCardId(selectedCardId);
          }
          break;
        case ' ':
          if (selectedCardId) {
            e.preventDefault();
            setSelectedItemId(selectedCardId);
          }
          break;
        case 'Escape':
          if (editingCardId) setEditingCardId(null);
          else if (selectedItemId) setSelectedItemId(null);
          else if (selectedCardId) setSelectedCardId(null);
          break;
        case 'n':
          e.preventDefault();
          palette.openCreateTask();
          break;
        case 'e':
          e.preventDefault();
          palette.openCreateEpic();
          break;
        case '?':
          e.preventDefault();
          setShowShortcutHelp(true);
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveSelection, selectedCardId, selectedItemId, editingCardId, palette]);

  // ── Awaiting-input count → board chip + <title> prefix ───────────────────
  const awaitingCount = useMemo(
    () => itemList.filter((i) => isAwaiting(i)).length,
    [itemList],
  );
  useEffect(() => {
    const base = 'TS Agent Orchestrator';
    document.title = awaitingCount > 0 ? `(${awaitingCount}) ${base}` : base;
    return () => { document.title = base; };
  }, [awaitingCount]);

  function handleTitleSave(id: string, next: string) {
    updateMutation.mutate(
      { id, title: next },
      {
        onSuccess: () => toast('Title updated', 'success'),
        onError: (err) => toast(`Failed: ${(err as Error).message}`, 'error'),
      },
    );
    setEditingCardId(null);
  }

  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (error) return <div className="p-6 text-destructive">Error: {(error as Error).message}</div>;

  return (
    <div className="h-full flex flex-col">
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              Issues
              {awaitingCount > 0 && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-medium text-amber-300"
                  title={`${awaitingCount} task${awaitingCount === 1 ? '' : 's'} awaiting input`}
                >
                  <span className="size-1.5 rounded-full bg-amber-400 animate-pulse" />
                  {awaitingCount} awaiting
                </span>
              )}
            </h2>
            <p className="text-sm text-muted-foreground">Kanban board for all work items</p>
          </div>
          <button
            type="button"
            onClick={() => setShowShortcutHelp(true)}
            className="text-xs text-muted-foreground hover:text-foreground"
            title="Show keyboard shortcuts (?)"
          >
            Shortcuts (?)
          </button>
        </div>
        <div className="flex gap-2 px-6 pb-4 flex-wrap items-center">
          <FilterSelect value={kindFilter} onChange={setKindFilter} placeholder="All types"
            options={['task', 'bug']} />
          <FilterSelect value={tagFilter} onChange={setTagFilter} placeholder="All tags"
            options={allTags ?? []} />
          <FilterSelect value={laneFilter} onChange={setLaneFilter} placeholder="All lanes"
            options={allLanes} />
          <div className="flex items-center gap-2">
            <Switch
              checked={groupBy === 'epic'}
              onCheckedChange={(checked) => setGroupBy(checked ? 'epic' : 'none')}
              id="group-by-epic"
            />
            <Label htmlFor="group-by-epic" className="text-sm cursor-pointer">Group by epic</Label>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={() => {
              setKindFilter(''); setTagFilter(''); setLaneFilter('');
            }} className="text-xs text-muted-foreground">Clear filters</Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-auto">
        <div className="p-6">
          {itemList.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-lg mb-2">No work items{hasFilters ? ' match filters' : ' yet'}</p>
              <p className="text-sm">{hasFilters ? 'Try adjusting your filters.' : 'Create items from the terminal (v0.8.0).'}</p>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
              {groupBy === 'epic' && epicGroups ? (
                <div>
                  {/* Column headers — rendered once at top */}
                  <div className="grid gap-1.5 mb-2" style={{ gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0, 1fr))` }}>
                    {COLUMNS.map((col) => {
                      const count = itemList.filter((i) => col.statuses.includes(i.status)).length;
                      const dotColor = STATUS_DOT_COLORS[col.label] ?? 'bg-gray-500';
                      return (
                        <div key={col.label} className="px-3 py-2 flex items-center gap-2">
                          <span className={`size-2.5 rounded-full ${dotColor} shrink-0`} />
                          <span className="text-sm font-medium">{col.label}</span>
                          <span className="text-xs text-muted-foreground ml-auto">{count}</span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Epic rows */}
                  <div className="space-y-1">
                    {epicGroups.map(([epicId, epicItems]) => {
                      const key = epicId ?? 'ungrouped';
                      const isCollapsed = collapsedEpics.has(key);
                      const cols = groupItemsIntoColumns(epicItems);
                      const doneCount = epicItems.filter((i) => i.status === 'done').length;
                      return (
                        <div key={key} className="border border-border rounded-lg bg-card/50">
                          {/* Epic header row */}
                          <button
                            className="flex items-center gap-2 w-full px-3 py-2.5 text-left hover:bg-accent/30 transition-colors rounded-lg"
                            onClick={() => setCollapsedEpics((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })}
                          >
                            {isCollapsed ? <ChevronRight className="size-4 text-muted-foreground shrink-0" /> : <ChevronDown className="size-4 text-muted-foreground shrink-0" />}
                            <KindIcon kind="task" size={16} className="shrink-0" />
                            <span className="text-sm font-medium">{epicId ? epicMap.get(epicId) ?? 'Unknown Epic' : 'Ungrouped'}</span>
                            <span className="text-xs text-muted-foreground ml-1">{doneCount} / {epicItems.length}</span>
                          </button>

                          {/* Cards grid — aligned to column headers */}
                          {!isCollapsed && (
                            <div className="grid gap-1.5 bg-border/40 rounded-b-lg overflow-hidden" style={{ gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0, 1fr))` }}>
                              {cols.map((col) => (
                                <DroppableColumn
                                  key={`${key}-${col.label}`}
                                  label={col.label}
                                  items={col.items}
                                  activeId={activeId}
                                  onCardClick={handleCardClick}
                                  columnId={`${key}-${col.label}`}
                                  showHeader={false}
                                  selectedCardId={selectedCardId}
                                  editingCardId={editingCardId}
                                  onTitleSave={handleTitleSave}
                                  onEditingChange={(id, editing) => setEditingCardId(editing ? id : null)}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="flex gap-4 h-full min-w-max">
                  {flatGrouped.map((col) => (
                    <DroppableColumn
                      key={col.label}
                      label={col.label}
                      items={col.items}
                      activeId={activeId}
                      onCardClick={handleCardClick}
                      columnId={col.label}
                      selectedCardId={selectedCardId}
                      editingCardId={editingCardId}
                      onTitleSave={handleTitleSave}
                      onEditingChange={(id, editing) => setEditingCardId(editing ? id : null)}
                    />
                  ))}
                </div>
              )}
              <DragOverlay>
                {activeItem ? <div className="opacity-80"><WorkItemCard item={activeItem} /></div> : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>

      {/* Shortcut help modal */}
      {showShortcutHelp && (
        <ShortcutHelpModal onClose={() => setShowShortcutHelp(false)} />
      )}

      {/* Detail drawer */}
      {selectedItemId && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setSelectedItemId(null)} />
          <WorkItemDrawer itemId={selectedItemId} onClose={() => setSelectedItemId(null)} />
        </>
      )}
    </div>
  );
}

type ColumnExtraProps = {
  selectedCardId: string | null;
  editingCardId: string | null;
  onTitleSave: (id: string, next: string) => void;
  onEditingChange: (id: string, editing: boolean) => void;
};

function DroppableColumn({ label, items, activeId, onCardClick, columnId, showHeader = true, selectedCardId, editingCardId, onTitleSave, onEditingChange }: {
  label: string; items: WorkItem[]; activeId: string | null; onCardClick: (id: string) => void; columnId: string; showHeader?: boolean;
} & ColumnExtraProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `column-${columnId}` });
  const itemIds = useMemo(() => items.map((i) => i.id), [items]);

  return (
    <div ref={setNodeRef} className={`flex-shrink-0 ${showHeader ? 'w-60 bg-card rounded-lg border' : 'bg-card'} flex flex-col transition-colors ${isOver && showHeader ? 'border-primary' : showHeader ? 'border-border' : ''}`}>
      {showHeader && (
        <div className="px-3 py-2 border-b border-border flex items-center justify-between">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">{items.length}</span>
        </div>
      )}
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <div className="p-2 space-y-2 flex-1 overflow-y-auto">
          {items.map((item) => (
            <SortableWorkItemCard
              key={item.id}
              item={item}
              isDragging={item.id === activeId}
              onCardClick={onCardClick}
              isSelected={item.id === selectedCardId}
              isEditing={item.id === editingCardId}
              onTitleSave={onTitleSave}
              onEditingChange={onEditingChange}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableWorkItemCard({ item, isDragging, onCardClick, isSelected, isEditing, onTitleSave, onEditingChange }: {
  item: WorkItem;
  isDragging: boolean;
  onCardClick: (id: string) => void;
  isSelected: boolean;
  isEditing: boolean;
  onTitleSave: (id: string, next: string) => void;
  onEditingChange: (id: string, editing: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging: isSortableDragging } = useSortable({ id: item.id, disabled: isEditing });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, touchAction: 'none',
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...(isEditing ? {} : listeners)}
      onClick={(e) => { if (!isSortableDragging && !isEditing) { e.stopPropagation(); onCardClick(item.id); } }}
    >
      <WorkItemCard
        item={item}
        isSelected={isSelected}
        isEditing={isEditing}
        onTitleSave={(next) => onTitleSave(item.id, next)}
        onEditingChange={(editing) => onEditingChange(item.id, editing)}
      />
    </div>
  );
}

function WorkItemCard({
  item,
  isSelected = false,
  isEditing = false,
  onTitleSave,
  onEditingChange,
}: {
  item: WorkItem;
  isSelected?: boolean;
  isEditing?: boolean;
  onTitleSave?: (next: string) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const raw = item as unknown as Record<string, unknown>;
  const laneBorder = laneBorderClass(item.lane);
  const categoryBorder = (item as any).category === 'personal' ? 'border-l-green-500' : 'border-l-blue-500';
  const borderColor = laneBorder ?? categoryBorder;
  const shortId = item.id.slice(0, 8);
  const activeSessionId = (item.activeSessionId ?? (raw.active_session_id as string | null)) || null;
  const createdAt = item.createdAt ?? (raw.created_at as string) ?? '';
  const assignedAgentId = item.assignedAgentId ?? (raw.assigned_agent_id as string | null);
  const awaiting = isAwaiting(item);

  // Dependency dot: green if ready-to-start with a predecessor; grey if waiting.
  // No dot for tasks with no predecessor.
  const hasPredecessor = !!item.dependsOnId;
  let dotNode: React.ReactNode = null;
  if (hasPredecessor) {
    if (item.readyToStart) {
      dotNode = (
        <span
          className="size-2 rounded-full bg-emerald-500"
          title="Ready — predecessor done."
        />
      );
    } else {
      dotNode = (
        <span
          className="size-2 rounded-full bg-muted-foreground/60"
          title={`Waiting on: ${item.blockedByTitle ?? 'predecessor'}`}
        />
      );
    }
  }

  const ringClass = isSelected ? 'ring-2 ring-ring ring-offset-1 ring-offset-background' : '';

  return (
    <div className={`border border-border border-l-4 ${borderColor} bg-card rounded p-3 hover:bg-accent/50 cursor-pointer transition-colors ${ringClass}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-muted-foreground font-mono">#{shortId}</span>
        <div className="flex items-center gap-2">
          {awaiting && (
            <span
              className="size-2 rounded-full bg-amber-400 animate-pulse"
              title="Claude is waiting on input"
            />
          )}
          {dotNode}
          {activeSessionId && (
            <a
              href={`/terminal?session=${activeSessionId}`}
              onClick={(e) => e.stopPropagation()}
              className="text-emerald-400 hover:text-emerald-300 transition-colors"
              title="View terminal session"
            >
              <Terminal className="size-3.5" />
            </a>
          )}
        </div>
      </div>
      <div className="flex items-start gap-2 mb-2">
        <KindIcon kind={item.kind} size={14} className="mt-0.5 shrink-0" />
        {onTitleSave ? (
          <div className="flex-1 min-w-0">
            <InlineTextField
              value={item.title}
              onSave={onTitleSave}
              ariaLabel="Edit task title"
              className="text-sm font-medium block"
              autoFocus={isEditing}
              onEditingChange={onEditingChange}
            />
          </div>
        ) : (
          <h4 className="text-sm font-medium line-clamp-2">{item.title}</h4>
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {timeAgo(createdAt)}
        </span>
        <span className="flex items-center gap-1">
          {item.lane && <span className="text-[10px] uppercase tracking-wide">{item.lane}</span>}
          <User className="h-3 w-3" />
          {assignedAgentId ?? 'Unassigned'}
        </span>
      </div>
    </div>
  );
}

function ShortcutHelpModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows: [string, string][] = [
    ['j / ↓', 'Next card in column'],
    ['k / ↑', 'Previous card in column'],
    ['h / ←', 'Column to the left'],
    ['l / →', 'Column to the right'],
    ['Enter', 'Edit selected card title'],
    ['Space', 'Open selected card in drawer'],
    ['Escape', 'Cancel edit / close drawer / clear selection'],
    ['n', 'New task (command palette)'],
    ['e', 'New epic (command palette)'],
    ['⌘K / Ctrl+K', 'Open command palette'],
    ['?', 'Show this help'],
  ];

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="fixed left-1/2 top-1/2 z-[61] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 shadow-xl"
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Keyboard shortcuts</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([keys, label]) => (
              <tr key={keys} className="border-t border-border">
                <td className="py-1.5 pr-3 font-mono text-xs text-muted-foreground">{keys}</td>
                <td className="py-1.5">{label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

type SelectOption = string | { value: string; label: string };

function FilterSelect({ value, onChange, placeholder, options }: {
  value: string; onChange: (v: string) => void; placeholder: string; options: SelectOption[];
}) {
  return (
    <Select value={value || ALL_VALUE} onValueChange={(v) => onChange(v === ALL_VALUE ? '' : v)}>
      <SelectTrigger className="w-[160px] h-8 text-sm">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_VALUE}>{placeholder}</SelectItem>
        {options.map((opt) => {
          const val = typeof opt === 'string' ? opt : opt.value;
          const label = typeof opt === 'string' ? opt.replace(/_/g, ' ') : opt.label;
          return <SelectItem key={val} value={val}>{label}</SelectItem>;
        })}
      </SelectContent>
    </Select>
  );
}
