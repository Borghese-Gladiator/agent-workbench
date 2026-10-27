import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogTitle } from '@client/components/ui/dialog';
import { Button } from '@client/components/ui/button';
import { Label } from '@client/components/ui/label';
import {
  useCreateEpic,
  useCreateWorkItem,
  useEpics,
  useWorkItems,
} from '@client/services/hooks';
import { useToast } from '@client/components/Toast';
import { KindIcon } from '@client/components/KindIcon';
import {
  FolderKanban,
  LayoutGrid,
  CheckSquare,
  Terminal as TerminalIcon,
  Activity as ActivityIcon,
  Plus,
  Search,
} from 'lucide-react';
import type { WorkItem, Epic } from '@shared/types';

// ── Context ─────────────────────────────────────────────────────────────────

type PaletteMode =
  | { kind: 'search'; initial: string }
  | { kind: 'create-task'; initialTitle: string }
  | { kind: 'create-epic'; initialTitle: string };

type CommandPaletteContextValue = {
  open: (mode?: Partial<PaletteMode>) => void;
  close: () => void;
  openCreateTask: (initialTitle?: string) => void;
  openCreateEpic: (initialTitle?: string) => void;
};

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) throw new Error('useCommandPalette must be used within CommandPaletteProvider');
  return ctx;
}

// ── Provider ────────────────────────────────────────────────────────────────

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<PaletteMode | null>(null);

  const open = useCallback<CommandPaletteContextValue['open']>((override) => {
    setMode({ kind: 'search', initial: '', ...override } as PaletteMode);
  }, []);
  const close = useCallback(() => setMode(null), []);
  const openCreateTask = useCallback((initialTitle = '') => {
    setMode({ kind: 'create-task', initialTitle });
  }, []);
  const openCreateEpic = useCallback((initialTitle = '') => {
    setMode({ kind: 'create-epic', initialTitle });
  }, []);

  const value = useMemo<CommandPaletteContextValue>(
    () => ({ open, close, openCreateTask, openCreateEpic }),
    [open, close, openCreateTask, openCreateEpic],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setMode((m) => (m ? null : { kind: 'search', initial: '' }));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {mode && (
        <CommandPaletteDialog
          mode={mode}
          setMode={setMode}
          onClose={close}
        />
      )}
    </CommandPaletteContext.Provider>
  );
}

// ── Navbar trigger button ───────────────────────────────────────────────────

export function CommandPaletteButton() {
  const { open } = useCommandPalette();
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/i.test(navigator.platform);
  return (
    <button
      type="button"
      onClick={() => open()}
      className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
      aria-label="Open command palette"
      title="Open command palette"
    >
      <Search className="size-4" />
      <span className="hidden md:inline">Search or create…</span>
      <kbd className="ml-2 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono">
        {isMac ? '⌘K' : 'Ctrl+K'}
      </kbd>
    </button>
  );
}

// ── Dialog + views ──────────────────────────────────────────────────────────

function CommandPaletteDialog({
  mode,
  setMode,
  onClose,
}: {
  mode: PaletteMode;
  setMode: (m: PaletteMode | null) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        {mode.kind === 'search' && (
          <SearchView
            initial={mode.initial}
            onCreateTask={(title) => setMode({ kind: 'create-task', initialTitle: title })}
            onCreateEpic={(title) => setMode({ kind: 'create-epic', initialTitle: title })}
            onClose={onClose}
          />
        )}
        {mode.kind === 'create-task' && (
          <CreateTaskView
            initialTitle={mode.initialTitle}
            onBack={() => setMode({ kind: 'search', initial: mode.initialTitle })}
            onDone={onClose}
          />
        )}
        {mode.kind === 'create-epic' && (
          <CreateEpicView
            initialTitle={mode.initialTitle}
            onBack={() => setMode({ kind: 'search', initial: mode.initialTitle })}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Search view ─────────────────────────────────────────────────────────────

type Action = {
  id: string;
  icon: React.ReactNode;
  label: string;
  group: string;
  hint?: string;
  run: () => void;
};

function SearchView({
  initial,
  onCreateTask,
  onCreateEpic,
  onClose,
}: {
  initial: string;
  onCreateTask: (title: string) => void;
  onCreateEpic: (title: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initial);
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const { data: workItems } = useWorkItems();
  const { data: epics } = useEpics();

  const actions = useMemo<Action[]>(() => {
    const q = query.trim();
    const out: Action[] = [];

    if (q.length > 0) {
      out.push({
        id: 'create-task',
        icon: <Plus className="size-4" />,
        label: `Create "${q}" as a new task`,
        group: 'Create',
        run: () => onCreateTask(q),
      });
      out.push({
        id: 'create-epic',
        icon: <FolderKanban className="size-4" />,
        label: `Create "${q}" as a new epic`,
        group: 'Create',
        run: () => onCreateEpic(q),
      });
    }

    for (const item of filterWorkItems(workItems ?? [], q)) {
      out.push({
        id: `wi-${item.id}`,
        icon: <KindIcon kind={item.kind} size={16} />,
        label: item.title,
        group: 'Work items',
        hint: `#${item.id.slice(0, 8)} · ${item.status}`,
        run: () => {
          navigate(`/work-items/${item.id}`);
          onClose();
        },
      });
    }

    for (const epic of filterEpics(epics ?? [], q)) {
      out.push({
        id: `epic-${epic.id}`,
        icon: <FolderKanban className="size-4" />,
        label: epic.title,
        group: 'Epics',
        run: () => {
          navigate(`/epics/${epic.id}`);
          onClose();
        },
      });
    }

    if (q.length === 0) {
      out.push({
        id: 'nav-board',
        icon: <LayoutGrid className="size-4" />,
        label: 'Go to Issues board',
        group: 'Navigate',
        run: () => { navigate('/'); onClose(); },
      });
      out.push({
        id: 'nav-tasks',
        icon: <CheckSquare className="size-4" />,
        label: 'Go to Tasks',
        group: 'Navigate',
        run: () => { navigate('/tasks'); onClose(); },
      });
      out.push({
        id: 'nav-terminal',
        icon: <TerminalIcon className="size-4" />,
        label: 'Go to Terminal',
        group: 'Navigate',
        run: () => { navigate('/terminal'); onClose(); },
      });
      out.push({
        id: 'nav-activity',
        icon: <ActivityIcon className="size-4" />,
        label: 'Go to Activity',
        group: 'Navigate',
        run: () => { navigate('/activity'); onClose(); },
      });
    }

    return out;
  }, [query, workItems, epics, onCreateTask, onCreateEpic, navigate, onClose]);

  useEffect(() => { setHighlight(0); }, [query]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${highlight}"]`,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(0, actions.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const a = actions[highlight];
      if (a) a.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  // Group actions by `group` preserving order.
  const grouped = useMemo(() => {
    const order: string[] = [];
    const by: Record<string, { action: Action; idx: number }[]> = {};
    actions.forEach((a, i) => {
      if (!by[a.group]) { by[a.group] = []; order.push(a.group); }
      by[a.group].push({ action: a, idx: i });
    });
    return order.map((g) => ({ group: g, items: by[g] }));
  }, [actions]);

  return (
    <div className="flex flex-col max-h-[70vh]">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Search className="size-4 text-muted-foreground shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search work items, epics, or type to create…"
          className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
        <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">Esc</kbd>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto py-2">
        {grouped.length === 0 && (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">No results.</div>
        )}
        {grouped.map(({ group, items }) => (
          <div key={group}>
            <div className="px-4 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">{group}</div>
            {items.map(({ action, idx }) => (
              <button
                key={action.id}
                data-idx={idx}
                type="button"
                onMouseEnter={() => setHighlight(idx)}
                onClick={action.run}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                  idx === highlight ? 'bg-accent/70 text-accent-foreground' : 'hover:bg-accent/30'
                }`}
              >
                <span className="shrink-0 text-muted-foreground">{action.icon}</span>
                <span className="flex-1 truncate">{action.label}</span>
                {action.hint && (
                  <span className="text-xs text-muted-foreground shrink-0 font-mono">{action.hint}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function filterWorkItems(items: WorkItem[], q: string): WorkItem[] {
  if (q.length === 0) return items.slice(0, 8);
  const lower = q.toLowerCase();
  const scored = items
    .map((item) => ({ item, score: scoreWorkItem(item, lower) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 20).map((x) => x.item);
}

function scoreWorkItem(item: WorkItem, lower: string): number {
  const title = item.title.toLowerCase();
  const shortId = item.id.slice(0, 8);
  if (shortId === lower) return 1000;
  if (title === lower) return 500;
  if (title.startsWith(lower)) return 200;
  if (title.includes(lower)) return 100;
  if ((item.body ?? '').toLowerCase().includes(lower)) return 20;
  return 0;
}

function filterEpics(
  epics: (Epic & { workItemCount?: number })[],
  q: string,
): Epic[] {
  if (q.length === 0) return epics.slice(0, 6);
  const lower = q.toLowerCase();
  return epics
    .filter((e) => e.title.toLowerCase().includes(lower))
    .slice(0, 12);
}

// ── Create task view ────────────────────────────────────────────────────────

function CreateTaskView({
  initialTitle,
  onBack,
  onDone,
}: {
  initialTitle: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [epicId, setEpicId] = useState<string>('');
  const [tags, setTags] = useState<string>('');
  const [kind, setKind] = useState<'task' | 'bug'>('task');
  const { data: epics } = useEpics();
  const createMut = useCreateWorkItem();
  const { toast } = useToast();

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const t = title.trim();
    if (!t) { toast('Title is required', 'error'); return; }
    createMut.mutate(
      {
        kind,
        title: t,
        tags: tags.split(',').map((x) => x.trim()).filter(Boolean),
        epic_id: epicId || undefined,
      },
      {
        onSuccess: () => {
          toast(`Created "${t}"`, 'success');
          onDone();
        },
        onError: (err) => toast(`Failed: ${(err as Error).message}`, 'error'),
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col p-5 gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Create task</h3>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to search
        </button>
      </div>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="cp-task-title">Title</Label>
          <input
            id="cp-task-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onBack(); } }}
            className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cp-task-epic">Epic</Label>
          <select
            id="cp-task-epic"
            value={epicId}
            onChange={(e) => setEpicId(e.target.value)}
            className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">(none)</option>
            {(epics ?? []).map((ep) => (
              <option key={ep.id} value={ep.id}>{ep.title}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cp-task-tags">Tags (comma-separated)</Label>
          <input
            id="cp-task-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="frontend, backend"
            className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex items-center gap-4">
          <Label className="text-xs">Kind:</Label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={kind === 'task'} onChange={() => setKind('task')} /> task
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={kind === 'bug'} onChange={() => setKind('bug')} /> bug
          </label>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onBack}>Cancel</Button>
        <Button type="submit" disabled={createMut.isPending}>Create</Button>
      </div>
    </form>
  );
}

// ── Create epic view ────────────────────────────────────────────────────────

function CreateEpicView({
  initialTitle,
  onBack,
  onDone,
}: {
  initialTitle: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState('');
  const createMut = useCreateEpic();
  const { toast } = useToast();

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const t = title.trim();
    if (!t) { toast('Title is required', 'error'); return; }
    createMut.mutate(
      { title: t, description: description.trim() || undefined },
      {
        onSuccess: () => {
          toast(`Created epic "${t}"`, 'success');
          onDone();
        },
        onError: (err) => toast(`Failed: ${(err as Error).message}`, 'error'),
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col p-5 gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Create epic</h3>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to search
        </button>
      </div>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="cp-epic-title">Title</Label>
          <input
            id="cp-epic-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onBack(); } }}
            className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cp-epic-desc">Description (optional)</Label>
          <textarea
            id="cp-epic-desc"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onBack}>Cancel</Button>
        <Button type="submit" disabled={createMut.isPending}>Create</Button>
      </div>
    </form>
  );
}
