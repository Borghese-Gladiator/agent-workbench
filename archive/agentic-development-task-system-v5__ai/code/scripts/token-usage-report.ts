#!/usr/bin/env -S npx tsx
// Cross-repo/cross-task token report (TASK-98). Opens the live workbench SQLite read-only and prints
// the aggregation from `getCrossRepoTokenReport` — tokens summed by repo/task/model/phase/outcome with
// the task's retry-lineage parent, plus grand totals — across every repo/task in the DB. This is the
// external export over the same query the daemon/CLI use, so a cross-repo cost roll-up needs no bespoke
// SQL. Read-only; never mutates.
//
// Usage (run from the repo root):
//   npx tsx scripts/token-usage-report.ts [--data-dir <dir>] [--db <path>]
//                                         [--repo <id> ...] [--task <id> ...] [--json]
// Defaults to $AWB_DATA_DIR/database/workbench.sqlite (or ~/.agentic-workbench/...).
//
// @awb/* packages are resolved from their built `dist/` via createRequire against each package's
// package.json — the same trick as scripts/measure-token-cost.mjs — so this runs from the repo root
// without the workspace symlinks a package dir would have. Build first: `pnpm --filter @awb/database build`.
import { createRequire } from 'node:module';

const requireDatabase = createRequire(new URL('../packages/database/package.json', import.meta.url));
const requireConfig = createRequire(new URL('../packages/config/package.json', import.meta.url));

const { createReadOnlyDatabase, getCrossRepoTokenReport } = requireDatabase('@awb/database') as typeof import('@awb/database');
const { resolveLayout } = requireConfig('@awb/config') as typeof import('@awb/config');

interface Args {
  dbPath?: string;
  dataDir?: string;
  repositoryIds: string[];
  taskIds: string[];
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { repositoryIds: [], taskIds: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--db') args.dbPath = argv[(i += 1)];
    else if (a === '--data-dir') args.dataDir = argv[(i += 1)];
    else if (a === '--repo') args.repositoryIds.push(argv[(i += 1)] ?? '');
    else if (a === '--task') args.taskIds.push(argv[(i += 1)] ?? '');
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: npx tsx scripts/token-usage-report.ts [--data-dir <dir>] [--db <path>] [--repo <id> ...] [--task <id> ...] [--json]',
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.dbPath ?? resolveLayout(args.dataDir).workbenchSqlite;

  const database = createReadOnlyDatabase(dbPath);
  try {
    const filter =
      args.repositoryIds.length > 0 || args.taskIds.length > 0
        ? {
            ...(args.repositoryIds.length > 0 ? { repositoryIds: args.repositoryIds } : {}),
            ...(args.taskIds.length > 0 ? { taskIds: args.taskIds } : {}),
          }
        : undefined;
    const report = getCrossRepoTokenReport(database.db, filter);

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const repos = new Set(report.rows.map((r) => r.repositoryId));
    console.log(`DB: ${dbPath}`);
    console.log(`Rows: ${report.rows.length}  Repos: ${repos.size}\n`);
    console.log(
      `  ${'repo'.padEnd(14)} ${'task'.padEnd(14)} ${'model'.padEnd(18)} ${'phase'.padEnd(10)} ` +
        `${'outcome'.padEnd(10)} ${'in'.padStart(8)} ${'out'.padStart(7)} ${'sess'.padStart(4)}  retry_of`,
    );
    for (const r of report.rows) {
      console.log(
        `  ${r.repositoryId.padEnd(14)} ${r.taskId.padEnd(14)} ${r.model.padEnd(18)} ` +
          `${r.phase.padEnd(10)} ${r.outcome.padEnd(10)} ${String(r.tokensIn).padStart(8)} ` +
          `${String(r.tokensOut).padStart(7)} ${String(r.sessions).padStart(4)}  ${r.retryOfTaskId ?? '—'}`,
      );
    }
    console.log(
      `\nTOTAL across ${repos.size} repo(s): in=${report.totals.tokensIn} out=${report.totals.tokensOut} ` +
        `sessions=${report.totals.sessions}`,
    );
  } finally {
    database.close();
  }
}

main();
