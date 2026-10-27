import { X, Plus } from 'lucide-react';
import { epicColorToCss } from '@client/utils/colors';
import type { TerminalSession, Epic } from '@shared/types';

interface TerminalTabBarProps {
  sessions: TerminalSession[];
  epicMap: Map<string, Epic>;
  workItemEpicMap: Map<string, string>; // workItemId → epicId
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewSession: () => void;
}

export function TerminalTabBar({
  sessions,
  epicMap,
  workItemEpicMap,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewSession,
}: TerminalTabBarProps) {
  return (
    <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-border bg-black/50 overflow-x-auto">
      {sessions.map((session) => {
        const epicId = session.primaryWorkItemId
          ? workItemEpicMap.get(session.primaryWorkItemId)
          : undefined;
        const epic = epicId ? epicMap.get(epicId) : undefined;
        const color = epicColorToCss(epic?.color);
        const isActive = session.id === activeSessionId;
        const truncatedTitle =
          session.title.length > 30
            ? session.title.slice(0, 30) + '...'
            : session.title;

        return (
          <button
            key={session.id}
            onClick={() => onSelectSession(session.id)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors min-w-0 shrink-0 ${
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground'
            }`}
            style={{ borderLeft: `3px solid ${color}` }}
          >
            <span className="truncate">{truncatedTitle}</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onCloseSession(session.id);
              }}
              className="p-0.5 rounded hover:bg-destructive/20 hover:text-destructive transition-colors"
            >
              <X className="size-3" />
            </span>
          </button>
        );
      })}

      <button
        onClick={onNewSession}
        className="flex items-center gap-1 px-3 py-1.5 rounded text-sm text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground transition-colors shrink-0"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}
