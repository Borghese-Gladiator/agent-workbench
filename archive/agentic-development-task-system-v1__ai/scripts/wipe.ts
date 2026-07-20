/**
 * Wipe script — truncates tables in the taskboard database.
 *
 * Usage:
 *   npx tsx scripts/wipe.ts --scope tasks     # work items + their dependents
 *   npx tsx scripts/wipe.ts --scope epics     # epics only (work items kept, epic_id nulled)
 *   npx tsx scripts/wipe.ts --scope all       # everything except agents
 *   npx tsx scripts/wipe.ts --scope all --agents          # also wipe agents
 *   npx tsx scripts/wipe.ts --scope all --ingest-files    # also delete files on disk
 *   npx tsx scripts/wipe.ts --scope tasks --yes           # skip confirmation
 *
 * Scope details:
 *   tasks  — DELETES: work_items (tasks + bugs + sub-tasks via cascade),
 *                     work_item_tags, reviews, artifacts (work-item-scoped),
 *                     task_session_links, activity_events for work_items.
 *            KEEPS:   epics, initiatives, agents, terminal_sessions,
 *                     ingest_files, artifacts scoped to epics only.
 *
 *   epics  — DELETES: epics, artifacts (epic-scoped), activity_events for epics.
 *            KEEPS:   work_items (their epic_id is set to NULL by FK),
 *                     initiatives, agents, terminal_sessions, ingest_files.
 *
 *   all    — DELETES everything in `tasks` and `epics` scopes PLUS
 *                     initiatives, terminal_sessions, ingest_files,
 *                     all activity_events, all reviews, all artifacts.
 *            KEEPS:   agents (unless --agents is passed).
 *
 * Flags:
 *   --agents         With --scope all, also wipe the agents table.
 *   --ingest-files   Also remove files under data/ingest/{processed,rejected,attachments}.
 *   --yes / -y       Skip the interactive confirmation prompt.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { getDb, getDbPath, closeDb } from "@server/db/connection.js";

export type Scope = "tasks" | "epics" | "all";

export interface Args {
  scope: Scope;
  agents: boolean;
  ingestFiles: boolean;
  yes: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { scope: "tasks", agents: false, ingestFiles: false, yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scope") {
      const v = argv[++i];
      if (v !== "tasks" && v !== "epics" && v !== "all") {
        throw new Error(`invalid --scope "${v}" (expected tasks | epics | all)`);
      }
      args.scope = v;
    } else if (a === "--agents") {
      args.agents = true;
    } else if (a === "--ingest-files") {
      args.ingestFiles = true;
    } else if (a === "--yes" || a === "-y") {
      args.yes = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      console.log(HELP);
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

const HELP = `wipe.ts — truncate tables in the taskboard database

  --scope <tasks|epics|all>  (default: tasks)
  --agents                   with --scope all, also wipe agents
  --ingest-files             also delete files under data/ingest/*
  --dry-run                  run the deletes inside a transaction, report
                             row counts, then roll back — no data is changed
  --yes, -y                  skip confirmation prompt
  --help, -h                 show this help`;

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

function describePlan(args: Args): string[] {
  const lines: string[] = [];
  if (args.scope === "tasks") {
    lines.push("Will DELETE from:");
    lines.push("  • work_items           (tasks, bugs, and sub-tasks — cascades to children)");
    lines.push("  • work_item_tags       (cascades from work_items)");
    lines.push("  • reviews              (cascades from work_items)");
    lines.push("  • task_session_links   (cascades from work_items)");
    lines.push("  • comments             (cascades from work_items, if table exists)");
    lines.push("  • artifacts            WHERE work_item_id IS NOT NULL");
    lines.push("  • activity_events      WHERE entity_type = 'work_item'");
    lines.push("Will UPDATE:");
    lines.push("  • terminal_sessions    SET primary_work_item_id = NULL (sessions kept)");
    lines.push("Will KEEP:");
    lines.push("  • epics, initiatives, agents, terminal_sessions (rows), ingest_files");
  } else if (args.scope === "epics") {
    lines.push("Will DELETE from:");
    lines.push("  • epics                (work_items.epic_id will be SET NULL)");
    lines.push("  • artifacts            WHERE epic_id IS NOT NULL");
    lines.push("  • activity_events      WHERE entity_type = 'epic'");
    lines.push("Will KEEP:");
    lines.push("  • work_items (epic link cleared), initiatives, agents, terminal_sessions, ingest_files");
  } else {
    lines.push("Will DELETE from:");
    lines.push("  • work_items, work_item_tags, reviews, artifacts, task_session_links");
    lines.push("  • comments (if table exists)");
    lines.push("  • epics, initiatives");
    lines.push("  • terminal_sessions");
    lines.push("  • activity_events, ingest_files");
    if (args.agents) lines.push("  • agents                (because --agents)");
    lines.push("Will KEEP:");
    if (!args.agents) lines.push("  • agents                (pass --agents to also wipe)");
    else lines.push("  • (nothing — full wipe)");
  }
  if (args.ingestFiles) {
    lines.push("Will ALSO delete files on disk:");
    lines.push("  • data/ingest/processed/*");
    lines.push("  • data/ingest/rejected/*");
    lines.push("  • data/ingest/attachments/*");
  }
  return lines;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return row !== undefined;
}

export function wipeDb(args: Args, dbOverride?: Database.Database): Record<string, number> {
  const db = dbOverride ?? getDb();
  const counts: Record<string, number> = {};

  const del = (sql: string, label: string) => {
    const info = db.prepare(sql).run();
    counts[label] = info.changes;
  };

  // terminal_sessions.primary_work_item_id → work_items(id) is NO ACTION,
  // so it blocks work_item deletes. Null it out before deleting work_items.
  const clearSessionWorkItemRefs = () => {
    const info = db
      .prepare(
        `UPDATE terminal_sessions SET primary_work_item_id = NULL WHERE primary_work_item_id IS NOT NULL`
      )
      .run();
    if (info.changes > 0) counts.terminal_sessions_unlinked = info.changes;
  };

  // A dry run executes the deletes inside a transaction and then throws,
  // so better-sqlite3 rolls the transaction back. We catch that sentinel
  // below. A real wipe lets the transaction commit normally.
  class DryRunAbort extends Error {}

  // Run inside a transaction so a failure leaves the DB untouched.
  const tx = db.transaction(() => {
    if (args.scope === "tasks") {
      // artifacts scoped to work_items only (epic-scoped rows are kept)
      del(`DELETE FROM artifacts WHERE work_item_id IS NOT NULL`, "artifacts");
      del(`DELETE FROM activity_events WHERE entity_type = 'work_item'`, "activity_events");
      clearSessionWorkItemRefs();
      // work_items cascade handles: work_item_tags, reviews, task_session_links,
      // comments (from migration 002), sub-tasks.
      del(`DELETE FROM work_items`, "work_items");
    } else if (args.scope === "epics") {
      del(`DELETE FROM artifacts WHERE epic_id IS NOT NULL`, "artifacts");
      del(`DELETE FROM activity_events WHERE entity_type = 'epic'`, "activity_events");
      // epics deletion sets work_items.epic_id to NULL via FK
      del(`DELETE FROM epics`, "epics");
    } else {
      // full wipe
      del(`DELETE FROM artifacts`, "artifacts");
      del(`DELETE FROM reviews`, "reviews");
      del(`DELETE FROM task_session_links`, "task_session_links");
      del(`DELETE FROM work_item_tags`, "work_item_tags");
      // comments table is added by migration 002; may not exist on older DBs.
      if (tableExists(db, "comments")) del(`DELETE FROM comments`, "comments");
      clearSessionWorkItemRefs();
      del(`DELETE FROM work_items`, "work_items");
      del(`DELETE FROM epics`, "epics");
      del(`DELETE FROM initiatives`, "initiatives");
      del(`DELETE FROM terminal_sessions`, "terminal_sessions");
      del(`DELETE FROM activity_events`, "activity_events");
      del(`DELETE FROM ingest_files`, "ingest_files");
      if (args.agents) del(`DELETE FROM agents`, "agents");
    }

    if (args.dryRun) throw new DryRunAbort();
  });

  try {
    tx();
  } catch (err) {
    if (!(err instanceof DryRunAbort)) throw err;
    // Dry run: transaction was rolled back, counts reflect what *would* change.
  }

  return counts;
}

export function wipeIngestFiles(projectRoot: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const base = path.join(projectRoot, "data", "ingest");
  for (const sub of ["processed", "rejected", "attachments"]) {
    const dir = path.join(base, sub);
    if (!fs.existsSync(dir)) {
      counts[sub] = 0;
      continue;
    }
    let n = 0;
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      fs.rmSync(p, { recursive: true, force: true });
      n++;
    }
    counts[sub] = n;
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = getDbPath();

  console.log(`Database: ${dbPath}`);
  console.log(`Scope:    ${args.scope}${args.dryRun ? "  (dry run — no changes will be committed)" : ""}`);
  console.log("");
  for (const line of describePlan(args)) console.log(line);
  console.log("");

  if (!fs.existsSync(dbPath)) {
    console.log("(database file does not exist — nothing to wipe in DB)");
    if (!args.ingestFiles) {
      closeDb();
      return;
    }
  }

  // Skip the confirmation prompt for dry runs — nothing is changed.
  if (!args.yes && !args.dryRun) {
    const ok = await confirm("Proceed?");
    if (!ok) {
      console.log("Aborted.");
      closeDb();
      process.exit(1);
    }
  }

  if (fs.existsSync(dbPath)) {
    const counts = wipeDb(args);
    console.log(args.dryRun ? "Would delete rows:" : "Deleted rows:");
    for (const [table, n] of Object.entries(counts)) {
      console.log(`  ${table.padEnd(26)} ${n}`);
    }
  }

  if (args.ingestFiles) {
    const projectRoot = path.resolve(path.dirname(dbPath), "..", "..");
    if (args.dryRun) {
      const base = path.join(projectRoot, "data", "ingest");
      console.log(args.dryRun ? "Would delete files:" : "Deleted files:");
      for (const sub of ["processed", "rejected", "attachments"]) {
        const dir = path.join(base, sub);
        const n = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
        console.log(`  data/ingest/${sub.padEnd(12)} ${n}`);
      }
    } else {
      const fileCounts = wipeIngestFiles(projectRoot);
      console.log("Deleted files:");
      for (const [sub, n] of Object.entries(fileCounts)) {
        console.log(`  data/ingest/${sub.padEnd(12)} ${n}`);
      }
    }
  }

  closeDb();
  console.log(args.dryRun ? "\nDry run complete — no changes made." : "\nDone.");
}

// Only run main() when invoked as a script, not when imported.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(`\nError: ${err.message}`);
    closeDb();
    process.exit(1);
  });
}
