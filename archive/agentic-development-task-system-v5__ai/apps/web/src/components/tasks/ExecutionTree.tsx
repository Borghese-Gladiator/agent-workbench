import { Badge } from '@/components/ui/badge';
import { elapsedBetween, formatTokens, shortId } from '@/lib/format';
import type { AgentSessionNode, ExecutionTreeResponse, PhaseAttemptNode } from '../../api/tasks.js';

/**
 * Renders the durable execution tree: Phase Attempts → Agent Sessions → Model Invocations. The phrase
 * "Phase attempt" is used deliberately — it is the retry unit WITHIN a task, distinct from a
 * "Retry as new task" which spawns a whole new task with its own tree. Reads only the projection.
 */
export function ExecutionTree({ tree }: { tree: ExecutionTreeResponse }) {
  if (tree.phaseAttempts.length === 0) {
    return <p className="text-sm text-muted-foreground">No phase attempts recorded yet.</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {tree.phaseAttempts.map((attempt) => (
        <PhaseAttemptRow key={attempt.id} attempt={attempt} />
      ))}
    </ol>
  );
}

function PhaseAttemptRow({ attempt }: { attempt: PhaseAttemptNode }) {
  return (
    <li className="rounded-md border bg-surface-2">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-semibold capitalize text-foreground">{attempt.phase}</span>
        <span className="text-xs text-muted-foreground">Phase attempt {attempt.attemptNumber}</span>
        {attempt.retryOf && (
          <Badge variant="outline" className="text-[10px]">
            retry of attempt {shortId(attempt.retryOf)}
          </Badge>
        )}
        {attempt.outcome && (
          <Badge variant={attempt.outcome === 'failed' ? 'abandoned' : 'done'} className="text-[10px]">
            {attempt.outcome}
          </Badge>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {elapsedBetween(attempt.startedAt, attempt.endedAt)}
        </span>
      </div>
      <div className="flex flex-col gap-2 p-3">
        {attempt.sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No agent sessions.</p>
        ) : (
          attempt.sessions.map((session) => <AgentSessionRow key={session.id} session={session} />)
        )}
      </div>
    </li>
  );
}

function AgentSessionRow({ session }: { session: AgentSessionNode }) {
  return (
    <div className="rounded border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-2.5 py-1.5">
        <span className="text-xs font-medium text-foreground">{session.runtime}</span>
        {session.model && <span className="text-xs text-muted-foreground">{session.model}</span>}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {elapsedBetween(session.startedAt, session.endedAt)}
        </span>
      </div>
      <ul className="flex flex-col divide-y">
        {session.invocations.length === 0 ? (
          <li className="px-2.5 py-1.5 text-[11px] text-muted-foreground">No model invocations.</li>
        ) : (
          session.invocations.map((inv) => (
            <li
              key={inv.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2.5 py-1.5 text-[11px] text-muted-foreground"
            >
              <span className="text-foreground">{inv.model}</span>
              <span className="tabular-nums">
                ↓ {formatTokens(inv.inputTokens)} · ↑ {formatTokens(inv.outputTokens)}
              </span>
              {inv.costUsd != null && <span className="tabular-nums">${inv.costUsd.toFixed(4)}</span>}
              <span className="ml-auto tabular-nums">{elapsedBetween(inv.startedAt, inv.endedAt)}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
