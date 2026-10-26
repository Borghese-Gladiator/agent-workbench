import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { TaskPhase } from '@awb/domain';
import { commandExecutions } from '../schema/index.js';
import type { DrizzleDb } from '../connection.js';
import type { CommandExecutionRow } from '../row-types.js';
import { ensureRunAndPhaseAttempt } from './tasks.js';

/**
 * Incremental `command_executions` observability for the verification matrix. The verify Activity
 * opens a row when it spawns a command (start time + command + cwd, null exit/ended) and closes it
 * out when the command finishes (ended_at + exit_code), so a live or failed verify shows one row per
 * command with real timing rather than nothing until the whole matrix returns.
 */

export interface CommandExecutionStart {
  phaseAttemptId: string;
  /** The run this phase attempt belongs to (`${taskId}-run`); its FK parent is ensured on insert. */
  runId: string;
  /** The phase the attempt is for, used only to seed the phase_attempts parent row when absent. */
  phase: TaskPhase;
  agentSessionId?: string;
  commandId?: string;
  command: string;
  cwd: string;
  startedAt: string;
}

export interface CommandExecutionFinish {
  exitCode: number | null;
  endedAt: string;
}

/**
 * Inserts a `command_executions` row on command spawn and returns its id. Ensures the run +
 * phase_attempts FK parents exist first so `foreign_keys=ON` never rejects the insert (the verify
 * phase attempt may not have been persisted yet when the first command starts).
 */
export function insertCommandExecution(db: DrizzleDb, input: CommandExecutionStart): string {
  ensureRunAndPhaseAttempt(db, {
    runId: input.runId,
    phaseAttemptId: input.phaseAttemptId,
    phase: input.phase,
  });
  const id = randomUUID();
  db.insert(commandExecutions)
    .values({
      id,
      agentSessionId: input.agentSessionId ?? null,
      phaseAttemptId: input.phaseAttemptId,
      commandId: input.commandId ?? null,
      command: input.command,
      cwd: input.cwd,
      exitCode: null,
      startedAt: input.startedAt,
      endedAt: null,
    })
    .run();
  return id;
}

/** Stamps ended_at + exit_code on a previously-inserted command_executions row on command finish. */
export function completeCommandExecution(db: DrizzleDb, id: string, finish: CommandExecutionFinish): void {
  db.update(commandExecutions)
    .set({ exitCode: finish.exitCode, endedAt: finish.endedAt })
    .where(eq(commandExecutions.id, id))
    .run();
}

/** Reads every command_executions row for a phase attempt, oldest-started first. */
export function getCommandExecutionsForPhaseAttempt(
  db: DrizzleDb,
  phaseAttemptId: string,
): CommandExecutionRow[] {
  return db
    .select()
    .from(commandExecutions)
    .where(eq(commandExecutions.phaseAttemptId, phaseAttemptId))
    .all()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
