import { Copy, Play } from 'lucide-react';
import { Button } from '@client/components/ui/button';

interface SessionInfoBarProps {
  tmuxSessionName: string | null;
  claudeSessionId: string | null;
  sessionState: string | null;
  isConnected: boolean;
  onResume: () => void;
}

export function SessionInfoBar({
  tmuxSessionName,
  claudeSessionId,
  sessionState,
  isConnected,
  onResume,
}: SessionInfoBarProps) {
  const stateBadge = (() => {
    if (!isConnected) return { label: 'disconnected', className: 'bg-yellow-500/20 text-yellow-400' };
    switch (sessionState) {
      case 'running': return { label: 'running', className: 'bg-emerald-500/20 text-emerald-400' };
      case 'exited': return { label: 'exited', className: 'bg-gray-500/20 text-gray-400' };
      default: return { label: sessionState ?? 'unknown', className: 'bg-gray-500/20 text-gray-400' };
    }
  })();

  const canResume = (sessionState === 'exited' || !isConnected) && !!claudeSessionId;

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  return (
    <div className="flex items-center gap-4 px-3 py-1.5 border-b border-border bg-card/50 text-xs">
      {tmuxSessionName && (
        <span className="text-muted-foreground">
          Session: <span className="font-mono text-foreground">{tmuxSessionName}</span>
        </span>
      )}

      {claudeSessionId && (
        <span className="flex items-center gap-1 text-muted-foreground">
          Claude:
          <code className="font-mono text-foreground">
            claude --resume {claudeSessionId}
          </code>
          <button
            onClick={() => copyToClipboard(`claude --resume ${claudeSessionId}`)}
            className="p-0.5 rounded hover:bg-accent transition-colors"
            title="Copy resume command"
          >
            <Copy className="size-3" />
          </button>
        </span>
      )}

      <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${stateBadge.className}`}>
        {stateBadge.label}
      </span>

      {canResume && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onResume}
          className="h-6 text-xs gap-1"
        >
          <Play className="size-3" />
          Resume Claude
        </Button>
      )}
    </div>
  );
}
