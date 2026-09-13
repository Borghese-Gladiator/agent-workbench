import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendScratchpadNote, readScratchpad, scratchpadPath } from './run-scratchpad.js';

const TASK = 'task-1';

// TASK-120: a long run had no working notes, only plan artifacts. On a cold re-entry the agent
// reconstructed its state from the plan — which states INTENT and says nothing about what was
// already tried — a direct contributor to `qa-cold-reentry-nonconvergence`.
describe('run scratchpad (TASK-120)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-scratchpad-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a titled scratchpad on the first note and appends after that', async () => {
    expect(appendScratchpadNote(dir, TASK, { phase: 'verify', attemptNumber: 1, note: 'the suite failed on a missing fixture' })).toBe(true);
    expect(appendScratchpadNote(dir, TASK, { phase: 'implement', attemptNumber: 2, note: 'added the fixture' })).toBe(true);

    const notes = readScratchpad(dir, TASK);
    expect(notes).toEqual([
      '- **verify #1** — the suite failed on a missing fixture',
      '- **implement #2** — added the fixture',
    ]);
  });

  it('reads back nothing on the first attempt of a run', () => {
    expect(readScratchpad(dir, TASK)).toEqual([]);
  });

  it('collapses whitespace so a multi-line note stays one entry', () => {
    appendScratchpadNote(dir, TASK, { phase: 'challenge', attemptNumber: 1, note: '  a finding\n   spanning lines  ' });
    expect(readScratchpad(dir, TASK)).toEqual(['- **challenge #1** — a finding spanning lines']);
  });

  // The point is to save the agent from re-deriving state, not to hand it an unbounded transcript
  // that costs more than the rediscovery would have.
  it('bounds what a cold re-entry re-reads to the most recent notes', () => {
    for (let i = 1; i <= 10; i++) {
      appendScratchpadNote(dir, TASK, { phase: 'implement', attemptNumber: i, note: `attempt ${i}` });
    }
    const notes = readScratchpad(dir, TASK, 3);
    expect(notes).toHaveLength(3);
    expect(notes.at(-1)).toContain('attempt 10');
    expect(notes[0]).toContain('attempt 8');
  });

  // Best-effort by contract: the scratchpad aids the next attempt and is never a correctness
  // dependency of this one, so a write that cannot land must not fail the phase.
  it('reports failure instead of throwing when the path cannot be written', async () => {
    const blocked = join(dir, 'blocked');
    await writeFile(blocked, 'not a directory');
    expect(appendScratchpadNote(blocked, TASK, { phase: 'plan', attemptNumber: 1, note: 'x' })).toBe(false);
    expect(readScratchpad(blocked, TASK)).toEqual([]);
  });

  it('keeps each task in its own file', async () => {
    await mkdir(join(dir, 'other'), { recursive: true });
    appendScratchpadNote(dir, TASK, { phase: 'plan', attemptNumber: 1, note: 'note for task 1' });
    appendScratchpadNote(dir, 'task-2', { phase: 'plan', attemptNumber: 1, note: 'note for task 2' });

    expect(scratchpadPath(dir, TASK)).not.toBe(scratchpadPath(dir, 'task-2'));
    expect(readScratchpad(dir, TASK)).toEqual(['- **plan #1** — note for task 1']);
    expect(readScratchpad(dir, 'task-2')).toEqual(['- **plan #1** — note for task 2']);
  });
});
