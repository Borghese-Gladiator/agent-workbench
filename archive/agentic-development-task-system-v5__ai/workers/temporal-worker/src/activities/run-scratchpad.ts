import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskPhase } from '@awb/domain';

/**
 * A persisted per-run scratchpad (TASK-120).
 *
 * A long run had no working notes — only plan artifacts. On a cold re-entry (a park, a resume, a
 * Temporal retry that restarts the agent turn from scratch) the agent had to reconstruct its state
 * from the plan, which is a statement of INTENT and says nothing about what has already been tried.
 * That is a direct contributor to the non-convergence pattern in `qa-cold-reentry-nonconvergence`.
 *
 * Deliberately small, per the ticket's bound: plain markdown, no new database table, no subagent
 * framing. It is append-only so a crash mid-write costs at most the last line, and it lives beside
 * the run's artifacts so it is removed with them.
 *
 * It is NOT the plan and must not become one. The plan says what we intend to do; this says what we
 * have already tried and what we learned doing it.
 */
const SCRATCHPAD_FILE = 'scratchpad.md';

/** One thing the run learned or decided, stamped with where it happened. */
export interface ScratchpadNote {
  phase: TaskPhase;
  attemptNumber: number;
  note: string;
}

export function scratchpadPath(artifactsDir: string, taskId: string): string {
  return join(artifactsDir, taskId, SCRATCHPAD_FILE);
}

/**
 * Appends a note. Best-effort by contract: a scratchpad write must never fail a phase, because the
 * scratchpad is an aid to the next attempt and not a correctness dependency of this one.
 */
export function appendScratchpadNote(artifactsDir: string, taskId: string, entry: ScratchpadNote): boolean {
  const path = scratchpadPath(artifactsDir, taskId);
  try {
    mkdirSync(join(artifactsDir, taskId), { recursive: true });
    const header = existsSync(path) ? '' : `# Run scratchpad — ${taskId}\n\n`;
    const line = `- **${entry.phase} #${entry.attemptNumber}** — ${entry.note.trim().replace(/\s+/g, ' ')}\n`;
    appendFileSync(path, `${header}${line}`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the scratchpad back for a resuming session, newest notes last.
 *
 * `maxNotes` bounds what a cold re-entry re-reads: the point is to save the agent from
 * re-deriving state, not to hand it an unbounded transcript that costs more than the rediscovery
 * would have. Returns an empty array when there is no scratchpad yet — the first attempt of a run.
 */
export function readScratchpad(artifactsDir: string, taskId: string, maxNotes = 40): string[] {
  const path = scratchpadPath(artifactsDir, taskId);
  try {
    if (!existsSync(path)) return [];
    const notes = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('- '));
    return notes.slice(-maxNotes);
  } catch {
    return [];
  }
}
