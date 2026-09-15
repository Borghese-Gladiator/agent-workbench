import type { Command } from 'commander';
import { daemonClient, DaemonRequestError } from '../daemon-client.js';
import { emitJson, outputOptions, printError, printInfo, printResult } from '../output.js';
import { formatColumns } from '../table.js';

type ReconcileDisposition = 'in-sync' | 'resynced' | 'abandoned' | 'unreachable';

interface ReconcileEntry {
  taskId: string;
  repositoryId: string;
  disposition: ReconcileDisposition;
  before: { phase: string; condition: string };
  after?: { phase: string; condition: string };
}

interface ReconcileResponse {
  scanned: number;
  counts: Record<ReconcileDisposition, number>;
  tasks: ReconcileEntry[];
}

/** What each disposition means, in one line, so the report explains itself. */
const EXPLANATION: Record<ReconcileDisposition, string> = {
  'in-sync': 'the row already agreed with Temporal',
  resynced: 'the row was behind and has been corrected from Temporal',
  abandoned: 'no Workflow backs this row any more',
  unreachable: 'Temporal could not be asked — the row was left alone',
};

/**
 * `awb reconcile` — the recovery command for after a network partition (TASK-111).
 *
 * A partition leaves SQLite behind the Temporal history: the worker→daemon writes are lost while the
 * daemon is down, so the workflow advances and the database does not. Before this, the operator's
 * only recourse was reading Temporal history by hand, with no way to tell a task that was merely
 * behind from one that was genuinely dead.
 */
export function registerReconcileCommand(program: Command): void {
  program
    .command('reconcile')
    .description('Re-sync task rows from Temporal after a partition, and report what was behind vs. dead')
    .action(async () => {
      let result: ReconcileResponse;
      try {
        result = await daemonClient.post<ReconcileResponse>('/api/reconcile', {});
      } catch (err) {
        printError(
          err instanceof DaemonRequestError
            ? `reconcile failed: ${err.message}`
            : `reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exitCode = 1;
        return;
      }

      if (outputOptions().json) {
        emitJson(result);
        return;
      }

      if (result.scanned === 0) {
        printInfo('no non-terminal tasks to reconcile');
        return;
      }

      // Only the rows that CHANGED are worth a table; an in-sync row is the boring, expected case.
      const changed = result.tasks.filter((t) => t.disposition !== 'in-sync');
      if (changed.length > 0) {
        for (const line of formatColumns(
          ['TASK', 'DISPOSITION', 'WAS', 'NOW'],
          changed.map((t) => [
            t.taskId.slice(0, 8),
            t.disposition,
            `${t.before.phase}|${t.before.condition}`,
            t.after ? `${t.after.phase}|${t.after.condition}` : '—',
          ]),
        )) {
          printResult(line);
        }
      }

      printInfo(`scanned ${result.scanned} task(s)`);
      for (const [disposition, count] of Object.entries(result.counts) as [ReconcileDisposition, number][]) {
        if (count > 0) printInfo(`  ${count} ${disposition} — ${EXPLANATION[disposition]}`);
      }
      if (result.counts.unreachable > 0) {
        printInfo('Next: `awb status` — some Workflows could not be reached, so those rows are unchanged.');
      }
    });
}
