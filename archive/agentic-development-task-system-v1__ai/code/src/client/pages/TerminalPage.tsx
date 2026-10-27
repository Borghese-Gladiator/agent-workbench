import { useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useSessions,
  useCreateSession,
  useResumeSession,
  useCloseSession,
  useWorkItems,
  useEpics,
} from '@client/services/hooks';
import { TerminalTabBar } from '@client/components/terminal/TerminalTabBar';
import { SessionInfoBar } from '@client/components/terminal/SessionInfoBar';
import { TerminalViewport } from '@client/components/terminal/TerminalViewport';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@client/components/ui/dialog';
import { Button } from '@client/components/ui/button';
import { KindIcon } from '@client/components/KindIcon';
import { Plus } from 'lucide-react';
import type { Epic, TerminalSession } from '@shared/types';

export function TerminalPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [localSessionState, setLocalSessionState] = useState<string | null>(null);
  const [localClaudeId, setLocalClaudeId] = useState<string | null>(null);

  const { data: sessions } = useSessions();
  const { data: workItems } = useWorkItems({ status: 'in_progress' });
  const { data: epics } = useEpics();
  const createSession = useCreateSession();
  const resumeSession = useResumeSession();
  const closeSession = useCloseSession();

  const activeSessions = useMemo(
    () => (sessions ?? []).filter((s) => s.state !== 'archived'),
    [sessions],
  );

  // Build epic lookup maps
  const epicMap = useMemo(() => {
    const m = new Map<string, Epic>();
    for (const e of epics ?? []) m.set(e.id, e);
    return m;
  }, [epics]);

  const workItemEpicMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const wi of workItems ?? []) {
      if (wi.epicId) m.set(wi.id, wi.epicId);
    }
    return m;
  }, [workItems]);

  // Active session from URL param or first session
  const urlSessionId = searchParams.get('session');
  const [selectedId, setSelectedId] = useState<string | null>(urlSessionId);

  const activeSessionId =
    selectedId && activeSessions.some((s) => s.id === selectedId)
      ? selectedId
      : activeSessions[0]?.id ?? null;

  const activeSession = activeSessions.find((s) => s.id === activeSessionId);

  function handleSelectSession(id: string) {
    setSelectedId(id);
    setSearchParams({ session: id });
    setLocalSessionState(null);
    setLocalClaudeId(null);
  }

  function handleCloseSession(id: string) {
    closeSession.mutate(id);
    if (activeSessionId === id) {
      const remaining = activeSessions.filter((s) => s.id !== id);
      setSelectedId(remaining[0]?.id ?? null);
    }
  }

  function handleNewSession() {
    setShowNewDialog(true);
  }

  function handleCreateSession(workItemId: string) {
    setShowNewDialog(false);
    createSession.mutate(workItemId, {
      onSuccess: (session: TerminalSession) => {
        setSelectedId(session.id);
        setSearchParams({ session: session.id });
      },
    });
  }

  function handleResume() {
    if (activeSessionId) {
      resumeSession.mutate(activeSessionId);
    }
  }

  const handleSessionStateChange = useCallback(
    (state: string | null, claudeId: string | null) => {
      setLocalSessionState(state);
      if (claudeId) setLocalClaudeId(claudeId);
    },
    [],
  );

  // Work items available for new sessions (in_progress, no active session)
  const availableWorkItems = (workItems ?? []).filter(
    (wi) => !wi.activeSessionId,
  );

  // Empty state
  if (activeSessions.length === 0 && !showNewDialog) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium mb-2">No active terminal sessions</p>
          <p className="text-sm mb-4">Start a session to begin working on a ticket with Claude Code.</p>
          <Button onClick={handleNewSession} className="gap-2">
            <Plus className="size-4" />
            New Session
          </Button>
          <NewSessionDialog
            open={showNewDialog}
            onClose={() => setShowNewDialog(false)}
            workItems={availableWorkItems}
            onSelect={handleCreateSession}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <TerminalTabBar
        sessions={activeSessions}
        epicMap={epicMap}
        workItemEpicMap={workItemEpicMap}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onCloseSession={handleCloseSession}
        onNewSession={handleNewSession}
      />

      {activeSession && (
        <SessionInfoBar
          tmuxSessionName={activeSession.tmuxSessionName}
          claudeSessionId={localClaudeId ?? activeSession.claudeSessionId}
          sessionState={localSessionState ?? activeSession.state}
          isConnected={true}
          onResume={handleResume}
        />
      )}

      {activeSessionId && (
        <TerminalViewport
          key={activeSessionId}
          sessionId={activeSessionId}
          onSessionStateChange={handleSessionStateChange}
        />
      )}

      <NewSessionDialog
        open={showNewDialog}
        onClose={() => setShowNewDialog(false)}
        workItems={availableWorkItems}
        onSelect={handleCreateSession}
      />
    </div>
  );
}

function NewSessionDialog({
  open,
  onClose,
  workItems,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  workItems: { id: string; title: string; kind: string }[];
  onSelect: (workItemId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Start Terminal Session</DialogTitle>
        </DialogHeader>
        <div className="space-y-1 max-h-80 overflow-y-auto">
          {workItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No in-progress work items without active sessions.
            </p>
          ) : (
            workItems.map((wi) => (
              <button
                key={wi.id}
                onClick={() => onSelect(wi.id)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded text-sm text-left hover:bg-accent transition-colors"
              >
                <KindIcon kind={wi.kind} size={14} />
                <span className="truncate">{wi.title}</span>
                <span className="text-xs text-muted-foreground font-mono ml-auto shrink-0">
                  #{wi.id.slice(0, 8)}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
