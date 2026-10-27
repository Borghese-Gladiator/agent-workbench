import { describe, expect, it } from 'vitest';
import type { NativeConnection } from '@temporalio/worker';
import { connectWithRetry } from './index.js';

const CONNECTION = {} as NativeConnection;

/** A fake clock the retry loop reads through `now`, advanced by the injected `delay`. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    delay: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('connectWithRetry (TASK-127)', () => {
  it('retries a refused connection instead of exiting', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const connection = await connectWithRetry('127.0.0.1:7233', {
      connect: async () => {
        attempts += 1;
        if (attempts < 4) throw new Error('Connection refused (os error 61)');
        return CONNECTION;
      },
      delay: clock.delay,
      now: clock.now,
      budgetMs: 60_000,
    });

    expect(connection).toBe(CONNECTION);
    expect(attempts).toBe(4);
  });

  it('backs off between attempts rather than spinning', async () => {
    const clock = fakeClock();
    const waits: number[] = [];
    let attempts = 0;
    await connectWithRetry('127.0.0.1:7233', {
      connect: async () => {
        attempts += 1;
        if (attempts < 5) throw new Error('Connection refused');
        return CONNECTION;
      },
      delay: async (ms) => {
        waits.push(ms);
        await clock.delay(ms);
      },
      now: clock.now,
      budgetMs: 60_000,
    });

    expect(waits).toEqual([250, 500, 1000, 2000]);
  });

  it('gives up once the budget is spent, surfacing the real error', async () => {
    const clock = fakeClock();
    await expect(
      connectWithRetry('127.0.0.1:7233', {
        connect: async () => {
          throw new Error('Connection refused (os error 61)');
        },
        delay: clock.delay,
        now: clock.now,
        budgetMs: 1_000,
      }),
    ).rejects.toThrow(/Connection refused/);
  });

  it('does not retry a connection that succeeds first time', async () => {
    let attempts = 0;
    await connectWithRetry('127.0.0.1:7233', {
      connect: async () => {
        attempts += 1;
        return CONNECTION;
      },
      delay: async () => {
        throw new Error('delay must not be called on a first-attempt success');
      },
    });
    expect(attempts).toBe(1);
  });
});
