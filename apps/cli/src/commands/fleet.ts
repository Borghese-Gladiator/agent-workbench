import type { Command } from 'commander';
import type { FleetTaskRow } from '@awb/database';
import { daemonClient, DaemonRequestError } from '../daemon-client.js';
import { emitJson, outputOptions, printError, printResult } from '../output.js';
import { formatDurationCoarse } from '../duration.js';
import { formatColumns } from '../table.js';

interface FleetResponse {
  tasks: FleetTaskRow[];
}

/** A short human age like "2m", "45s", "1h" for a whole-second duration. */
export function formatAge(sec: number | null): string {
  return formatDurationCoarse(sec == null ? null : sec * 1000);
}

/** The attempt cell — "#2 ↩verify" when the run regressed, "#1" on a clean first pass. */
export function formatAttempt(row: FleetTaskRow): string {
  const base = `#${row.attempt}`;
  return row.bouncedFrom ? `${base} ↩${row.bouncedFrom}` : base;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

interface Column {
  header: string;
  value: (r: FleetTaskRow) => string;
}

const COLUMNS: Column[] = [
  { header: 'TASK', value: (r) => shortTaskId(r.taskId) },
  { header: 'REPO', value: (r) => truncate(r.repositoryName ?? '—', 16) },
  { header: 'PHASE', value: (r) => r.phase },
  { header: 'COND', value: (r) => r.condition },
  { header: 'ATTEMPT', value: formatAttempt },
  { header: 'ACTIVITY', value: (r) => (r.activity ? `${truncate(r.activity, 40)} (${formatAge(r.activityAgeSec)})` : '—') },
  { header: 'FINDINGS', value: (r) => (r.openFindings > 0 ? `${r.openFindings} open` : '—') },
  { header: 'PR', value: (r) => (r.pr ? `#${r.pr.number ?? '?'}${r.pr.isDraft ? ' draft' : ''}` : '—') },
];

/** Fixed-width aligned table for a human on a TTY. */
export function renderTable(rows: FleetTaskRow[]): string {
  if (rows.length === 0) return 'No tasks.';
  const cells = rows.map((r) => COLUMNS.map((c) => c.value(r)));
  return formatColumns(COLUMNS.map((c) => c.header), cells).join('\n');
}

/** GitHub-flavored markdown table — the agent-legible default an LLM pastes into its reasoning. */
export function renderMarkdown(rows: FleetTaskRow[]): string {
  const headers = COLUMNS.map((c) => c.header);
  const sep = COLUMNS.map(() => '---');
  const bodyRows = rows.map((r) => COLUMNS.map((c) => c.value(r).replace(/\|/g, '\\|')));
  const line = (cols: string[]): string => `| ${cols.join(' | ')} |`;
  return [line(headers), line(sep), ...bodyRows.map(line)].join('\n');
}

async function fetchFleet(): Promise<FleetTaskRow[]> {
  const res = await daemonClient.get<FleetResponse>('/api/tasks/fleet');
  return res.tasks;
}

function emitOnce(rows: FleetTaskRow[], format: 'table' | 'md'): void {
  if (outputOptions().json) {
    emitJson({ tasks: rows });
    return;
  }
  printResult(format === 'md' ? renderMarkdown(rows) : renderTable(rows));
}

export function registerFleetCommand(program: Command): void {
  program
    .command('fleet')
    .description('Show a composed, agent-legible status line for every task (activity, bounce, findings, PR)')
    .option('--md', 'Render a markdown table (agent-legible default for LLM monitoring)')
    .option('--watch', 'Continuously re-render on an interval (human TUI); Ctrl-C to exit')
    .option('--interval <seconds>', 'Watch refresh interval in seconds', '3')
    .action(async (opts: { md?: boolean; watch?: boolean; interval: string }) => {
      const format: 'table' | 'md' = opts.md ? 'md' : 'table';
      try {
        if (!opts.watch) {
          emitOnce(await fetchFleet(), format);
          return;
        }
        // --watch is a human affordance; under --json it makes no sense, so fall back to one-shot.
        if (outputOptions().json) {
          emitOnce(await fetchFleet(), format);
          return;
        }
        const intervalMs = Math.max(1, Number(opts.interval) || 3) * 1000;
        let stop = false;
        const onSigint = (): void => {
          stop = true;
        };
        process.on('SIGINT', onSigint);
        while (!stop) {
          const rows = await fetchFleet();
          // Clear screen + home cursor, then paint.
          process.stdout.write('\x1b[2J\x1b[H');
          process.stdout.write(`awb fleet — ${new Date().toLocaleTimeString()} (${rows.length} tasks, Ctrl-C to exit)\n\n`);
          process.stdout.write(`${renderTable(rows)}\n`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        process.off('SIGINT', onSigint);
      } catch (err) {
        if (err instanceof DaemonRequestError) printError(err.message);
        else printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
