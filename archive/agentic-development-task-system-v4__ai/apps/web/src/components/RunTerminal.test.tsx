import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RunTerminal } from './RunTerminal';

vi.mock('../api.js', () => ({
  api: { runEventsUrl: (taskId: string, runId: string) => `/sse/${taskId}/${runId}` },
}));

/** EventSource fake that records listeners and lets tests dispatch typed events. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 0;
  closed = false;
  onerror: ((e: unknown) => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  dispatch(type: string, payload: unknown, id = '1') {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(payload), lastEventId: id } as MessageEvent);
    }
  }
}
vi.stubGlobal('EventSource', FakeEventSource);

function lastES(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
}

function renderTerminal(over: Partial<Parameters<typeof RunTerminal>[0]> = {}) {
  const onTerminal = vi.fn();
  const onQuestion = vi.fn();
  render(
    <RunTerminal
      taskId="t1"
      runId="r1"
      stage="Discovery"
      onTerminal={onTerminal}
      onQuestion={onQuestion}
      {...over}
    />,
  );
  return { onTerminal, onQuestion, es: lastES() };
}

beforeEach(() => {
  FakeEventSource.instances.length = 0;
});

describe('RunTerminal', () => {
  it('folds consecutive assistant_text deltas into one flowing block', () => {
    const { es } = renderTerminal();
    act(() => {
      es.dispatch('assistant_text', { text: 'Hel' });
      es.dispatch('assistant_text', { text: 'lo ' });
      es.dispatch('assistant_text', { text: 'world' });
    });
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders the cost/turns/token breakdown from a cost event', () => {
    const { es } = renderTerminal();
    act(() => {
      es.dispatch('cost', {
        totalCostUsd: 0.91,
        numTurns: 12,
        inputTokens: 22000,
        outputTokens: 4000,
        cacheCreationInputTokens: 1500,
        cacheReadInputTokens: 310000,
      });
    });
    expect(
      screen.getByText('12 turns · $0.9100 · 22k in · 4k out · 310k cached'),
    ).toBeInTheDocument();
  });

  it('renders just turns + cost when token fields are absent (mock run)', () => {
    const { es } = renderTerminal();
    act(() => {
      es.dispatch('cost', {
        totalCostUsd: 0,
        numTurns: 1,
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      });
    });
    expect(screen.getByText('1 turns · $0.0000')).toBeInTheDocument();
  });

  it('renders tool calls, results, and errors with their markers', () => {
    const { es } = renderTerminal();
    act(() => {
      es.dispatch('tool_call', { name: 'Read', input: { file: 'a.ts' } });
      es.dispatch('tool_result', { status: 'ok', summary: '120 lines' });
      es.dispatch('tool_result', { status: 'error', summary: 'denied' });
    });
    expect(screen.getByText(/❯ Read\(/)).toBeInTheDocument();
    expect(screen.getByText(/✓ 120 lines/)).toBeInTheDocument();
    expect(screen.getByText(/✗ denied/)).toBeInTheDocument();
  });

  it('pauses on ask_question (onQuestion, NOT onTerminal) and resumes on answer', () => {
    const { es, onTerminal, onQuestion } = renderTerminal();
    act(() => {
      es.dispatch('ask_question', { question: 'Which approach?' });
    });
    expect(onQuestion).toHaveBeenCalledTimes(1);
    expect(onTerminal).not.toHaveBeenCalled();
    // Stays mounted, flagged as awaiting input, and the stream stays open.
    expect(screen.getByText('awaiting input')).toBeInTheDocument();
    expect(es.closed).toBe(false);

    act(() => {
      es.dispatch('question_answered', { questionId: 'q1' });
    });
    expect(screen.getByText('streaming')).toBeInTheDocument();
    expect(screen.getByText(/resuming/)).toBeInTheDocument();
  });

  it('closes the stream and calls onTerminal on result', () => {
    const { es, onTerminal } = renderTerminal();
    act(() => {
      es.dispatch('result', { subtype: 'success', isError: false });
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(es.closed).toBe(true);
    expect(screen.getByText(/run finished \(success\)/)).toBeInTheDocument();
  });

  it('renders an error line and terminates on error events', () => {
    const { es, onTerminal } = renderTerminal();
    act(() => {
      es.dispatch('error', { message: 'spawn failed' });
    });
    expect(screen.getByText(/✗ spawn failed/)).toBeInTheDocument();
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(es.closed).toBe(true);
  });

  it('replays a finished run (live=false) without re-firing onTerminal', () => {
    // A finished run mounts in replay mode: the server replays its transcript
    // (including the terminal result) and closes. The view must stay put — it's
    // the persistent post-run view, so onTerminal (which clears it) must NOT fire.
    const { es, onTerminal } = renderTerminal({ live: false });
    expect(screen.getByText('done')).toBeInTheDocument();
    act(() => {
      es.dispatch('assistant_text', { text: 'I read the repo.' });
      es.dispatch('result', { subtype: 'success', isError: false });
    });
    expect(screen.getByText('I read the repo.')).toBeInTheDocument();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('shows a failed badge when a finished run ended in error (live=false)', () => {
    const { es } = renderTerminal({ live: false });
    act(() => {
      es.dispatch('error', { message: 'max turns' });
    });
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('does NOT treat a connection close/error as terminal (lets EventSource reconnect)', () => {
    // A transient socket error must not fire onTerminal — the terminal EVENT is
    // authoritative, not the close. Otherwise a reconnect blip clears the view.
    const { es, onTerminal } = renderTerminal();
    act(() => {
      es.readyState = FakeEventSource.CLOSED;
      es.onerror?.({});
    });
    expect(onTerminal).not.toHaveBeenCalled();
    expect(screen.getByText('streaming')).toBeInTheDocument();
  });

  it('fires onTerminal at most once even if the terminal event is replayed again', () => {
    // After a reconnect the server replays the run including its result; the
    // guard must keep onTerminal idempotent.
    const { es, onTerminal } = renderTerminal();
    act(() => {
      es.dispatch('result', { subtype: 'success', isError: false });
      es.dispatch('result', { subtype: 'success', isError: false });
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});
