import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useActivityEvents,
  useSessions,
  useResumeSession,
} from '@client/services/hooks';
import { StatusBadge } from '@client/components/StatusBadge';
import { timeAgo } from '@client/utils/time';
import { ENTITY_TYPES } from '@shared/constants';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@client/components/ui/select';
import { Badge } from '@client/components/ui/badge';
import { Button } from '@client/components/ui/button';
import {
  Layers,
  CheckSquare,
  Terminal,
  Activity as ActivityIcon,
  GitPullRequest,
  Clock,
  Code,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from 'lucide-react';
import type { TerminalSession, SessionState } from '@shared/types';

function getIconForType(entityType: string) {
  switch (entityType) {
    case 'epic': return Layers;
    case 'work_item': return CheckSquare;
    case 'session': return Terminal;
    case 'review': return GitPullRequest;
    default: return ActivityIcon;
  }
}

function getColorForEvent(eventType: string): string {
  if (eventType.includes('done') || eventType.includes('completed'))
    return 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20';
  if (eventType.includes('fail') || eventType.includes('error'))
    return 'text-red-500 bg-red-500/10 border-red-500/20';
  if (eventType.includes('created'))
    return 'text-blue-500 bg-blue-500/10 border-blue-500/20';
  if (eventType.includes('review'))
    return 'text-purple-500 bg-purple-500/10 border-purple-500/20';
  if (eventType.includes('update') || eventType.includes('changed'))
    return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20';
  return 'text-muted-foreground bg-muted/50 border-border';
}

const STATE_DOT_CLASS: Record<SessionState, string> = {
  running: 'bg-emerald-500',
  starting: 'bg-yellow-500',
  exited: 'bg-red-500',
  disconnected: 'bg-gray-400',
  archived: 'bg-gray-600',
};

function isInactive(state: SessionState): boolean {
  return state === 'exited' || state === 'disconnected';
}

function sessionTimeInfo(session: TerminalSession): string {
  if (isInactive(session.state)) {
    const ref = session.exitedAt ?? session.lastSeenAt ?? session.startedAt;
    return `Inactive ${timeAgo(ref)}`;
  }
  return `Started ${timeAgo(session.startedAt)}`;
}

function SessionCard({ session }: { session: TerminalSession }) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const resumeSession = useResumeSession();

  const workItemTitle = session.workItemTitle ?? session.title;
  const showSecondaryTitle =
    session.title && session.title !== workItemTitle;

  function handleOpenTerminal(e: React.MouseEvent) {
    e.stopPropagation();
    const needsResume =
      isInactive(session.state) && !!session.claudeSessionId;
    if (needsResume) {
      resumeSession.mutate(session.id, {
        onSettled: () => navigate(`/terminal?session=${session.id}`),
      });
    } else {
      navigate(`/terminal?session=${session.id}`);
    }
  }

  return (
    <div
      onClick={() => setExpanded((v) => !v)}
      className="relative flex-grow basis-48 min-w-[12rem] max-w-sm border border-border rounded-lg p-3 cursor-pointer hover:bg-accent/30 transition-colors"
    >
      <div className="flex items-start gap-2 pr-6">
        <span
          className={`mt-1 inline-block size-2 rounded-full shrink-0 ${STATE_DOT_CLASS[session.state] ?? 'bg-gray-400'}`}
          aria-label={session.state}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{workItemTitle}</p>
          {showSecondaryTitle && (
            <p className="text-xs text-muted-foreground truncate">
              {session.title}
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            {sessionTimeInfo(session)}
          </p>
        </div>
      </div>

      <div className="absolute bottom-2 right-2 text-muted-foreground">
        {expanded ? (
          <ChevronUp className="size-4" />
        ) : (
          <ChevronDown className="size-4" />
        )}
      </div>

      {expanded && (
        <div
          className="mt-3 pt-3 border-t border-border space-y-1.5 text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          {session.branchName && (
            <div className="flex gap-1.5">
              <span className="text-muted-foreground shrink-0">Branch:</span>
              <span className="font-mono truncate">{session.branchName}</span>
            </div>
          )}
          {session.cwd && (
            <div className="flex gap-1.5">
              <span className="text-muted-foreground shrink-0">Cwd:</span>
              <span className="font-mono truncate" title={session.cwd}>
                {session.cwd}
              </span>
            </div>
          )}
          {session.state === 'exited' && (
            <div className="flex gap-1.5">
              <span className="text-muted-foreground shrink-0">Exit:</span>
              <span className="font-mono">{session.exitCode ?? '?'}</span>
            </div>
          )}
          <div className="flex gap-1.5">
            <span className="text-muted-foreground shrink-0">Session:</span>
            <span
              className="font-mono truncate select-all"
              title={session.id}
            >
              {session.id}
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="w-full mt-2 gap-1.5"
            onClick={handleOpenTerminal}
          >
            <ExternalLink className="size-3.5" />
            Open Terminal
          </Button>
        </div>
      )}
    </div>
  );
}

export function ActivityPage() {
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>('');
  const { data: events, isLoading, error } = useActivityEvents({
    entityType: entityTypeFilter || undefined,
    limit: 100,
    refetchInterval: 10_000,
  });
  const { data: sessions } = useSessions();
  const activeSessions = (sessions ?? []).filter(
    (s) => s.state !== 'archived',
  );

  const [secondsAgo, setSecondsAgo] = useState(0);
  const lastFetchRef = useRef(Date.now());

  useEffect(() => {
    if (events) {
      lastFetchRef.current = Date.now();
      setSecondsAgo(0);
    }
  }, [events]);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastFetchRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  if (isLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (error) return <div className="p-6 text-red-500">Error: {(error as Error).message}</div>;

  return (
    <div className="h-full flex flex-col">
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Activity</h2>
            <p className="text-sm text-muted-foreground">Sessions and event stream</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75 animate-ping" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
              <Clock className="size-3" />
              <span>Updated {secondsAgo}s ago</span>
            </div>
            <Select value={entityTypeFilter} onValueChange={(val) => setEntityTypeFilter(val === 'all' ? '' : val)}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{t.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Session Cards */}
        {activeSessions.length > 0 && (
          <div className="px-6 pt-5 pb-3">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <Terminal className="size-3.5" /> Sessions
            </h3>
            <div className="flex flex-wrap gap-3">
              {activeSessions.map((session) => (
                <SessionCard key={session.id} session={session} />
              ))}
            </div>
          </div>
        )}

        {/* Timeline */}
        <div className="p-6 pt-3">
          {!events || events.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <ActivityIcon className="mx-auto size-10 mb-3 opacity-40" />
              <p className="text-lg mb-2">No activity yet</p>
              <p className="text-sm">Events will appear here as the system processes work items.</p>
            </div>
          ) : (
            <div className="relative">
              {events.map((event, idx) => {
                let payload: Record<string, unknown> | null = null;
                try { payload = JSON.parse(event.payloadJson); } catch { /* ignore */ }

                const Icon = getIconForType(event.entityType);
                const colorClasses = getColorForEvent(event.eventType);
                const isLast = idx === events.length - 1;

                return (
                  <div key={event.id} className="flex gap-4">
                    <div className="flex flex-col items-center">
                      <div className={`flex items-center justify-center size-8 rounded-lg border bg-background ${colorClasses}`}>
                        <Icon className="size-4" />
                      </div>
                      {!isLast && <div className="w-px flex-1 bg-border" />}
                    </div>
                    <div className="flex-1 min-w-0 pb-6">
                      <div className="rounded-lg border border-border p-3 transition-colors hover:bg-accent/50">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <StatusBadge status={event.eventType} />
                          <Badge variant="outline" className="text-xs font-normal">{event.entityType.replace(/_/g, ' ')}</Badge>
                          {event.entityId && (
                            <span className="text-xs text-muted-foreground font-mono">{event.entityId.slice(0, 8)}</span>
                          )}
                          <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">{timeAgo(event.occurredAt)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {event.actorType}: {event.actorId ?? 'system'}
                          {event.sourceType && <span className="ml-2">via {event.sourceType}</span>}
                        </div>
                        {payload && Object.keys(payload).length > 0 && (
                          <div className="mt-2 flex items-start gap-1.5">
                            <Code className="size-3 mt-0.5 shrink-0 text-muted-foreground" />
                            <pre className="bg-muted/50 rounded p-2 font-mono text-xs text-muted-foreground truncate max-w-full">
                              {JSON.stringify(payload).slice(0, 200)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
