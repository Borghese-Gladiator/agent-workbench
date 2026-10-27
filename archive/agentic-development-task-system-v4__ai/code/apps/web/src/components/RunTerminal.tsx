import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { type CostSummary, costSegments } from '@/lib/cost';
import { cn } from '@/lib/utils';
import { api } from '../api.js';

/**
 * Read-only terminal view of a live agent run. Subscribes to the daemon's SSE
 * endpoint via EventSource; the server replays the run's persisted events on
 * attach, so mounting mid-run (or after a reload) shows the full history before
 * streaming continues. Purely an observer — it never sends input.
 *
 * Callback contract (important for the active-run poller in TaskDetail):
 * - `onTerminal` fires ONLY on `result`/`error` — the run is over, the parent
 *   may unmount this component.
 * - `onQuestion` fires on `ask_question` — the run is paused, NOT over. The
 *   parent reloads to surface the QuestionCard while the terminal stays
 *   mounted; streaming resumes in place on `question_answered`.
 */
export function RunTerminal({
  taskId,
  runId,
  stage,
  live = true,
  onTerminal,
  onQuestion,
  onCost,
}: {
  taskId: string;
  runId: string;
  /** Stage label for the header bar (from the polled run record). */
  stage?: string;
  /**
   * Whether this run is still in flight. When false the run already finished —
   * the server replays its transcript then closes the stream, so we keep the
   * view mounted (badge shows `done`) and DON'T fire `onTerminal` on the close
   * (there's nothing to tear down; firing it would clear the persistent view).
   */
  live?: boolean;
  onTerminal: () => void;
  onQuestion?: () => void;
  /** Optional: bubble each `cost` event up (e.g. for a header counter). */
  onCost?: (cost: CostSummary) => void;
}) {
  const [lines, setLines] = useState<TermLine[]>([]);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  // Set once a `result`/`error` event arrives — drives the header badge so a
  // replayed (finished) run reads `done`/`failed` rather than `streaming`.
  const [ended, setEnded] = useState<null | 'ok' | 'error'>(null);
  // The terminal EVENT (not the socket) is authoritative for end-of-run. This
  // guards against re-firing `onTerminal` if a `result` is replayed again after
  // we've already ended (e.g. on an EventSource reconnect).
  const endedRef = useRef(false);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;
  const onQuestionRef = useRef(onQuestion);
  onQuestionRef.current = onQuestion;
  const onCostRef = useRef(onCost);
  onCostRef.current = onCost;
  const liveRef = useRef(live);
  liveRef.current = live;

  // Auto-scroll: stick to the bottom unless the user scrolled up to read.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stuckRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    setLines([]);
    setCost(null);
    setAwaiting(false);
    setEnded(null);
    endedRef.current = false;
    stuckRef.current = true;
    const es = new EventSource(api.runEventsUrl(taskId, runId));

    const push = (type: string) => (e: MessageEvent) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      setLines((prev) => appendEvent(prev, type, payload));
      switch (type) {
        case 'cost': {
          const c = payload as unknown as CostSummary;
          setCost(c);
          onCostRef.current?.(c);
          break;
        }
        case 'ask_question':
          // The run paused for input — surface the quiz, keep streaming view up.
          setAwaiting(true);
          onQuestionRef.current?.();
          break;
        case 'question_answered':
          setAwaiting(false);
          break;
        // A live run that just ended tells the parent to stop polling and re-pin
        // this run as the (now finished) display run. A replay of an already-
        // finished run must not fire onTerminal — it would clear the view.
        // The terminal EVENT is authoritative (not the socket close); guard with
        // endedRef so a re-replayed terminal after reconnect is a no-op.
        case 'result':
          setEnded(payload.isError === true ? 'error' : 'ok');
          es.close();
          if (liveRef.current && !endedRef.current) onTerminalRef.current();
          endedRef.current = true;
          break;
        case 'error':
          setEnded('error');
          es.close();
          if (liveRef.current && !endedRef.current) onTerminalRef.current();
          endedRef.current = true;
          break;
      }
    };

    for (const t of [
      'assistant_text',
      'tool_call',
      'tool_result',
      'ask_question',
      'question_answered',
      'cost',
      'result',
      'error',
    ]) {
      es.addEventListener(t, push(t));
    }
    // A closed/errored socket is NOT terminal: native EventSource auto-reconnects
    // on a transient blip (re-sending Last-Event-ID), and the daemon always emits
    // an explicit `result`/`error` event before it ends the stream. Treating the
    // close as terminal would falsely tear down the view on a reconnect. The
    // terminal EVENT handlers above are the only thing that fires `onTerminal`.
    es.onerror = () => {
      /* let EventSource reconnect; terminal is signalled by the event, not close */
    };

    return () => es.close();
  }, [taskId, runId]);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <span className="text-zinc-300">agent{stage ? ` · ${stage}` : ''}</span>
        {ended === 'error' ? (
          <Badge variant="abandoned">failed</Badge>
        ) : ended === 'ok' || !live ? (
          <Badge variant="done">done</Badge>
        ) : awaiting ? (
          <Badge variant="approval">awaiting input</Badge>
        ) : (
          <Badge variant="active">streaming</Badge>
        )}
        {cost && <span className="ml-auto text-zinc-500">{costSegments(cost).join(' · ')}</span>}
      </div>
      <div
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-[55vh] min-h-32 overflow-y-auto p-3 leading-relaxed"
        aria-live="polite"
        aria-label="Live agent output"
      >
        {lines.length === 0 && <div className="text-zinc-600">Waiting for output…</div>}
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              'whitespace-pre-wrap break-words',
              l.kind === 'text' && 'text-zinc-200',
              l.kind === 'tool_call' && 'mt-1 text-sky-400',
              l.kind === 'tool_result' && 'text-zinc-500',
              l.kind === 'status' && 'mt-1 text-amber-400',
              l.kind === 'error' && 'mt-1 text-red-400',
            )}
          >
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

interface TermLine {
  kind: 'text' | 'tool_call' | 'tool_result' | 'status' | 'error';
  text: string;
}

const MAX_LINE = 400;

function truncate(s: string, max = MAX_LINE): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Fold an incoming event into the rendered lines. Consecutive `assistant_text`
 * deltas merge into one flowing block — the CLI streams tiny partial-message
 * deltas, and a line per delta would be unreadable (and slow).
 */
function appendEvent(prev: TermLine[], type: string, p: Record<string, unknown>): TermLine[] {
  switch (type) {
    case 'assistant_text': {
      const text = String(p.text ?? '');
      if (!text) return prev;
      const last = prev[prev.length - 1];
      if (last?.kind === 'text') {
        return [...prev.slice(0, -1), { kind: 'text', text: last.text + text }];
      }
      return [...prev, { kind: 'text', text }];
    }
    case 'tool_call':
      return [
        ...prev,
        {
          kind: 'tool_call',
          text: `❯ ${String(p.name ?? '?')}(${truncate(JSON.stringify(p.input ?? {}), 160)})`,
        },
      ];
    case 'tool_result': {
      const ok = p.status !== 'error';
      return [
        ...prev,
        { kind: 'tool_result', text: `  ${ok ? '✓' : '✗'} ${truncate(String(p.summary ?? ''))}` },
      ];
    }
    case 'ask_question':
      return [
        ...prev,
        { kind: 'status', text: `? ${String(p.question ?? '(question)')} — awaiting your answer` },
      ];
    case 'question_answered':
      return [...prev, { kind: 'status', text: '✓ answer received — resuming' }];
    case 'result': {
      const failed = p.isError === true;
      return [
        ...prev,
        {
          kind: 'status',
          text: `— run finished${p.subtype ? ` (${String(p.subtype)})` : ''}${failed ? ' with errors' : ''}`,
        },
      ];
    }
    case 'error':
      return [...prev, { kind: 'error', text: `✗ ${String(p.message ?? 'run failed')}` }];
    default:
      return prev;
  }
}
