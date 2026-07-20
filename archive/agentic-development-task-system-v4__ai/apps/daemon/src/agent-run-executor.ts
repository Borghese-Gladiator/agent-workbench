/**
 * AgentRunExecutor — owns the lifecycle of a streaming agent run: it creates the
 * AgentRun row, drives the adapter's `streamStageAgent` in the background,
 * persists each streamed event to the store, and fans events out to live SSE
 * subscribers through an in-memory bus.
 *
 * It deliberately does NOT advance the task lifecycle — running an agent and
 * gating a stage stay separate concerns. The mid-run input gate (questions /
 * permission prompts) is layered on in a later increment via `requestInput`.
 */

import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  StreamEvent,
  StreamHandlers,
} from '@workbench/agents';
import type {
  AgentQuestion,
  AgentQuestionAnswer,
  AgentRun,
  AgentRunEvent,
  CostEventPayload,
  Stage,
  TurnEventPayload,
} from '@workbench/core';
import type { Store } from '@workbench/store';
import { runLogger } from './logger.js';
import { QuestionGate } from './question-gate.js';

/**
 * A model turn whose time-to-first-token meets or exceeds this is logged as a
 * `slow-turn` WARN. ~20s is well above an interactive Opus turn (single-digit
 * seconds) yet below the silent gaps observed in non-interactive stage runs.
 */
const SLOW_TURN_WARN_MS = 20_000;

/** A live subscriber callback for a run's events. */
type Subscriber = (event: AgentRunEvent) => void;

export interface StartRunInput {
  taskId: string;
  stage: Stage;
  adapter: AgentRuntimeAdapter;
  worktreePath?: string;
  contextArtifactIds: string[];
  /** Resolved prior-artifact bodies inlined into the prompt (see `contextKindsForStage`). */
  contextArtifacts?: AgentRunInput['contextArtifacts'];
  /** Project memory log inlined for discovery/planning (see `stageWantsProjectMemory`). */
  projectMemory?: AgentRunInput['projectMemory'];
  allowedTools: string[];
  taskTitle: string;
  rawRequest: string;
  /** Ask the brief agent to derive a real title (current title is a placeholder). */
  deriveTitle?: boolean;
  /** Reviewer feedback to thread into the prompt (rejection/bounce redo). */
  reviewerFeedback?: string;
  /**
   * Resume an existing Claude session instead of starting fresh: the adapter
   * runs `--resume <sessionId>` and sends ONLY `message`. Used by the brief
   * rejection redo so the reviewer's comment continues the brief's own session.
   */
  resume?: { sessionId: string; message: string };
  /** Per-stage model override (`--model`); see `modelForStage`. Threaded to the adapter. */
  model?: string;
  /** Per-stage effort override (`--effort`); see `effortForStage`. Threaded to the adapter. */
  effort?: AgentRunInput['effort'];
  /**
   * Skill instructions to inject into the stage prompt (review/QA stages). The
   * service composes this from the routed skill bodies; the executor only threads
   * it through to the adapter. Absent for stages without skills.
   */
  skillText?: string;
  /** Detected repo profile, for output skill-compliance verification. */
  repoProfile?: string;
  /**
   * Run WITHOUT the mid-run question gate. Used for the autonomous auto-advance
   * implementation run: there is no human watching the stream to answer edit
   * prompts, so the run must be self-driving (acceptEdits auto-approves). When
   * true the adapter is invoked with no `gate`, so mutating tools auto-approve
   * instead of routing to a (nonexistent) human.
   */
  ungated?: boolean;
  /** Extra env for the spawned CLI (e.g. the QA harness wiring). Threaded to the adapter. */
  env?: Record<string, string>;
  /**
   * Persist the produced transcript + artifacts on success. Returns nothing;
   * the caller (service) owns artifact attribution. Optional so a bare run can
   * skip artifact persistence.
   */
  persistResult?: (result: {
    transcript: { kind: string; title: string; body: string };
    produced: { kind: string; title: string; body: string }[];
  }) => void;
}

/** Terminal outcome of an executed run (the executor itself never throws). */
export interface RunOutcome {
  status: 'succeeded' | 'failed';
  error?: string;
}

export class AgentRunExecutor {
  /** runId -> set of live subscribers. */
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  /**
   * runId -> abort controller for the in-flight run. Registered while a run is
   * executing and cleared when it finishes. `stop()` aborts it to kill the
   * spawned CLI subprocess (operator "stop session").
   */
  private readonly aborters = new Map<string, AbortController>();
  /** The mid-run human-input gate, shared by the in-process + HTTP-relay paths. */
  readonly gate: QuestionGate;

  /**
   * @param daemonUrl base URL the spawned MCP gate server relays back to. When
   *   omitted, real-CLI runs get no MCP gate (the mock path still gates
   *   in-process). Set in production from the daemon's own bound address.
   */
  constructor(
    private readonly store: Store,
    private readonly daemonUrl?: string,
  ) {
    this.gate = new QuestionGate(store, {
      emit: (runId, type, payload) => {
        this.emit(runId, { type, payload });
      },
    });
  }

  /**
   * Start a run in the background. Returns the created AgentRun immediately
   * (status `running`); events stream asynchronously.
   */
  start(input: StartRunInput): AgentRun {
    const run = this.store.createAgentRun({ taskId: input.taskId, stage: input.stage });
    // Detached run: nothing awaits this promise, so it MUST NOT reject. `execute`
    // records its own failures, but a throw outside its try (e.g. the gate path,
    // or a store write after the process tore the store down) would otherwise be
    // an unhandled rejection — fatal to the process under Node's default handling
    // (and the cause of the intermittent vitest-worker flake). Swallow as the
    // last line of defense; the failure, if any, is already on the run record.
    this.execute(run.id, input).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      runLogger(run.id).error({ err: message }, 'detached agent run rejected (swallowed)');
    });
    return run;
  }

  /**
   * Run a stage agent to completion and return its terminal result. Same
   * persistence + event streaming as {@link start}, but AWAITED — used by the
   * auto-advance driver for the `implementation` stage, where the lifecycle must
   * only move forward once the agent's edits actually landed. Events still stream
   * to any SSE subscribers via the created run id.
   */
  async runToCompletion(input: StartRunInput): Promise<{ run: AgentRun; result: AgentRunResult }> {
    const run = this.store.createAgentRun({ taskId: input.taskId, stage: input.stage });
    const result = await this.execute(run.id, input);
    return { run, result };
  }

  /**
   * Start a run and await its terminal outcome. Used by the lifecycle driver so
   * stage work streams through the same event pipeline as manual runs. Never
   * rejects — failures come back as `{status: 'failed', error}`.
   */
  async run(input: StartRunInput): Promise<{ run: AgentRun } & RunOutcome> {
    const { run, result } = await this.runToCompletion(input);
    return { run, status: result.status, error: result.error };
  }

  /** Answer a pending question (resumes the run). Delegates to the gate. */
  answer(questionId: string, answer: AgentQuestionAnswer): AgentQuestion | null {
    return this.gate.answer(questionId, answer);
  }

  /**
   * Abort an in-flight run, killing its spawned CLI subprocess. Returns true if
   * a live run was found and aborted, false otherwise (already finished, or this
   * run is not tracked here — e.g. an orphan swept on a prior boot). `execute`
   * records the aborted run as `failed`; the caller decides how to backstop a
   * false return.
   */
  stop(runId: string): boolean {
    const aborter = this.aborters.get(runId);
    if (!aborter) return false;
    aborter.abort();
    return true;
  }

  /** Subscribe to a run's live events. Returns an unsubscribe function. */
  subscribe(runId: string, sub: Subscriber): () => void {
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(sub);
    return () => {
      set!.delete(sub);
      if (set!.size === 0) this.subscribers.delete(runId);
    };
  }

  /** Persist an event and fan it out to live subscribers. */
  private emit(runId: string, ev: StreamEvent): AgentRunEvent {
    // Stamp receive time BEFORE the synchronous store write so its divergence
    // from the insert-time `createdAt` isolates daemon-side persist delay.
    const stored = this.store.appendAgentRunEvent({
      runId,
      type: ev.type,
      payload: ev.payload,
      receivedAt: new Date().toISOString(),
    });
    const subs = this.subscribers.get(runId);
    if (subs) {
      for (const s of subs) {
        // A subscriber is typically an SSE writer; if its socket is gone the
        // write can throw. Never let one bad subscriber break persistence or
        // the run.
        try {
          s(stored);
        } catch {
          /* ignore broken subscriber */
        }
      }
    }
    return stored;
  }

  private async execute(runId: string, input: StartRunInput): Promise<AgentRunResult> {
    // Run-scoped logger: every line carries `runId` so a single `grep <runId>`
    // stitches this together with the gate server's stderr and the `/ask` relay.
    const log = runLogger(runId);
    const gated = Boolean(this.daemonUrl);
    log.info({ taskId: input.taskId, stage: input.stage, gated }, 'agent run start');

    // Every run's event log must end with a `result`/`error` event — SSE
    // clients reload task state when they see one, so it must land strictly
    // AFTER artifacts/status are persisted. Adapters emit their terminal event
    // as soon as the CLI prints its result line (seconds before the process
    // exits and persistence runs); hold those back and let the terminal event
    // be re-emitted by the outcome branches below.
    const held: { terminal: { type: 'result' | 'error'; payload: unknown } | null } = {
      terminal: null,
    };
    // Track the latest `cost` event so we can persist it onto the AgentRun row
    // when the run finishes — without it, cost/turns/tokens are only ever
    // visible in the live SSE stream and vanish on reload. Held on an object
    // (like `held` above) so TS tracks the closure mutation across the await.
    const cost: CostEventPayload = {
      totalCostUsd: null,
      numTurns: null,
      durationMs: null,
      durationApiMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    // The run's first-turn TTFT, lifted from the first `turn` event that carries
    // one. Held alongside `cost` so it can be persisted onto the row on finish.
    const latency: { ttftMs: number | null } = { ttftMs: null };
    const handlers: StreamHandlers = {
      onEvent: (ev) => {
        if (ev.type === 'result' || ev.type === 'error') {
          held.terminal = { type: ev.type, payload: ev.payload };
          return;
        }
        if (ev.type === 'cost') {
          Object.assign(cost, ev.payload as CostEventPayload);
        }
        // Surface a slow model turn live: a per-turn time-to-first-token past the
        // threshold is the silent gap the profiling work is chasing. Logged with
        // the turn's token counts so the WARN itself carries the H1/H2 signal
        // (big input / low cache-read → prefill-bound) without a post-hoc query.
        if (ev.type === 'turn') {
          const t = ev.payload as TurnEventPayload;
          // Capture the first turn's TTFT for the run row (the first `turn` event
          // with a measured ttft; later turns stay in the event stream only).
          if (latency.ttftMs == null && t.ttftMs != null) {
            latency.ttftMs = t.ttftMs;
          }
          if (t.ttftMs != null && t.ttftMs >= SLOW_TURN_WARN_MS) {
            log.warn(
              {
                turn: t.index,
                ttftMs: t.ttftMs,
                inputTokens: t.inputTokens,
                cacheReadInputTokens: t.cacheReadInputTokens,
                outputTokens: t.outputTokens,
              },
              'slow-turn: model time-to-first-token exceeded threshold',
            );
          }
        }
        this.emit(runId, ev);
        // NOTE: `durationMs` rides on the emitted `cost` EVENT only (no row column
        // for it). `durationApiMs` IS persisted onto the row — see `runCostPatch`.
      },
      // Route mid-run input requests through the gate (in-process path, used by
      // the mock adapter). The real claude CLI routes through the spawned MCP
      // server -> daemon HTTP relay -> the same gate.
      requestInput: (question) => this.gate.ask(runId, input.taskId, question),
      // Record the spawned process group id so a later daemon boot can reap this
      // run's orphaned process tree if we crash mid-run.
      onSpawn: (pgid) => {
        this.store.updateAgentRun(runId, { pgid });
      },
    };

    // Adapters without a streaming method fall back to the one-shot path,
    // wrapped so it still produces a terminal result here.
    const runStreaming =
      input.adapter.streamStageAgent?.bind(input.adapter) ??
      (async (i: Parameters<NonNullable<AgentRuntimeAdapter['streamStageAgent']>>[0]) => {
        const r = await input.adapter.runStageAgent(i);
        return r;
      });

    // Register an abort controller so an operator "stop session" can kill this
    // run's spawned CLI. Threaded as `signal` into the adapter (the claude
    // adapter folds it into its stall watchdog -> SIGKILL). Cleared in `finally`.
    const aborter = new AbortController();
    this.aborters.set(runId, aborter);

    try {
      const result = await runStreaming(
        {
          taskId: input.taskId,
          stage: input.stage,
          worktreePath: input.worktreePath,
          contextArtifactIds: input.contextArtifactIds,
          contextArtifacts: input.contextArtifacts,
          projectMemory: input.projectMemory,
          allowedTools: input.allowedTools,
          taskTitle: input.taskTitle,
          rawRequest: input.rawRequest,
          deriveTitle: input.deriveTitle,
          skillText: input.skillText,
          repoProfile: input.repoProfile,
          reviewerFeedback: input.reviewerFeedback,
          resume: input.resume,
          model: input.model,
          effort: input.effort,
          env: input.env,
          signal: aborter.signal,
          // Real-CLI runs get the MCP gate wired to relay back to this daemon —
          // unless this is an autonomous (ungated) run, where there is no human
          // to answer prompts, so mutating tools must auto-approve instead.
          gate: this.daemonUrl && !input.ungated ? { daemonUrl: this.daemonUrl, runId } : undefined,
        },
        handlers,
      );

      // The agent_runs row carries cost/turns/tokens + `durationApiMs`, but NOT
      // the wall-clock `durationMs` (no column). Strip only `durationMs` so the
      // spread can't emit a `duration_ms` column, and fold in the captured TTFT.
      const { durationMs: _dMs, ...runCostPatch } = { ...cost, ttftMs: latency.ttftMs };

      if (result.status === 'succeeded') {
        input.persistResult?.({ transcript: result.transcript, produced: result.produced });
        this.store.updateAgentRun(runId, {
          status: 'succeeded',
          finishedAt: new Date().toISOString(),
          // Spread the cost+token breakdown captured from the `cost` event.
          ...runCostPatch,
          // Persist the session id so a later run (e.g. a brief rejection) can
          // `--resume` this conversation rather than re-prompt from scratch.
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        });
        // Emit the (held or synthetic) terminal event last, after the status
        // flip, so an SSE handler's post-event status check sees the run as
        // finished and closes the response.
        this.emit(runId, {
          type: 'result',
          payload:
            held.terminal?.type === 'result'
              ? held.terminal.payload
              : { subtype: 'success', isError: false, denials: [] },
        });
        log.info({ produced: result.produced.length }, 'agent run succeeded');
        return result;
      }
      // Persist the transcript even on failure so it's not lost. Emit the error
      // event AFTER the status flip so an SSE handler's post-event status check
      // sees the run as finished and closes the response.
      input.persistResult?.({ transcript: result.transcript, produced: [] });
      this.store.updateAgentRun(runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        // A mid-stream `result` can carry usage even on a non-success subtype.
        ...runCostPatch,
        error: result.error ?? 'run failed',
      });
      this.emit(runId, { type: 'error', payload: { message: result.error ?? 'run failed' } });
      log.warn({ error: result.error ?? 'run failed' }, 'agent run failed');
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'agent run threw');
      // The run is detached (`void this.execute`), so a throw here would be an
      // unhandled rejection. Guard the failure-recording writes — if the store
      // is gone (e.g. shut down), there's nothing left to record anyway.
      try {
        this.store.updateAgentRun(runId, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: message,
        });
        this.emit(runId, { type: 'error', payload: { message } });
      } catch {
        /* store unavailable — nothing to record */
      }
      // Surface a terminal failed result so the awaited caller (auto-advance)
      // can decide not to advance. The transcript is synthesized since the run
      // never produced one.
      return {
        status: 'failed',
        transcript: { kind: 'log', title: `Agent run — ${input.stage}`, body: message },
        produced: [],
        error: message,
      };
    } finally {
      // The run is over (success, failure, or abort) — drop its aborter so a
      // late `stop()` can't fire a SIGKILL at an unrelated future process.
      this.aborters.delete(runId);
    }
  }
}
