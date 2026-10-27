/**
 * Tests for scripts/wipe.ts
 *
 * Run:
 *   npx tsx tests/wipe.test.ts
 *
 * Each test builds a fresh DB in a temp dir, seeds a known set of rows across
 * every table, runs wipeDb() with a given scope, and asserts which rows
 * survived.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@server/db/migrate.js";
import { wipeDb, wipeIngestFiles, type Args } from "../scripts/wipe.js";

// ── Test runner ─────────────────────────────────────────────────────────────

type Test = { name: string; fn: () => void };
const tests: Test[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// ── Fixture helpers ─────────────────────────────────────────────────────────

const NOW = "2026-04-16T00:00:00.000Z";

function freshDb(): { db: Database.Database; dbPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wipe-test-"));
  const dbPath = path.join(tmpDir, "test.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return {
    db,
    dbPath,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Seed a complete set of rows covering every table and every cross-table
 * relationship the wipe logic touches.
 *
 * Returns ids so tests can assert on specific rows.
 */
function seedFixtures(db: Database.Database) {
  // initiatives
  db.prepare(
    `INSERT INTO initiatives (id, slug, name, description, status, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 0, ?, ?)`
  ).run("init-1", "growth", "Growth", "desc", NOW, NOW);

  // epics (one linked to init-1)
  db.prepare(
    `INSERT INTO epics (id, initiative_id, slug, title, description, status, color, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', 'blue', 0, ?, ?)`
  ).run("epic-1", "init-1", "onboarding", "Onboarding revamp", "desc", NOW, NOW);
  db.prepare(
    `INSERT INTO epics (id, initiative_id, slug, title, description, status, color, sort_order, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, 'open', 'red', 0, ?, ?)`
  ).run("epic-2", "orphan", "Orphan epic", "desc", NOW, NOW);

  // agents
  db.prepare(
    `INSERT INTO agents (id, name, kind, description, is_active, created_at, updated_at)
     VALUES (?, ?, 'executor', ?, 1, ?, ?)`
  ).run("agent-1", "exec-1", "executor", NOW, NOW);

  // work_items — parent + child, one per epic
  db.prepare(
    `INSERT INTO work_items (id, epic_id, parent_id, slug, kind, title, body, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'task', ?, '', 'triage', ?, ?)`
  ).run("wi-parent", "epic-1", "parent", "Parent task", NOW, NOW);
  db.prepare(
    `INSERT INTO work_items (id, epic_id, parent_id, slug, kind, title, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'task', ?, '', 'triage', ?, ?)`
  ).run("wi-child", "epic-1", "wi-parent", "child", "Child sub-task", NOW, NOW);
  db.prepare(
    `INSERT INTO work_items (id, epic_id, parent_id, slug, kind, title, body, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'bug', ?, '', 'triage', ?, ?)`
  ).run("wi-orphan", "epic-2", "orphan-task", "Orphan task", NOW, NOW);

  // work_item_tags
  db.prepare(`INSERT INTO work_item_tags (work_item_id, tag) VALUES (?, ?)`).run("wi-parent", "frontend");
  db.prepare(`INSERT INTO work_item_tags (work_item_id, tag) VALUES (?, ?)`).run("wi-child", "backend");

  // reviews
  db.prepare(
    `INSERT INTO reviews (id, work_item_id, reviewer_agent_id, review_type, outcome, summary, created_at)
     VALUES (?, ?, ?, 'standard', 'approved', ?, ?)`
  ).run("rev-1", "wi-parent", "agent-1", "looks good", NOW);

  // terminal_sessions — one with a dangling primary_work_item_id (the NO ACTION
  // FK that caused the real-world FK failure) and one without.
  db.prepare(
    `INSERT INTO terminal_sessions (id, title, state, started_at, primary_work_item_id)
     VALUES (?, ?, 'running', ?, ?)`
  ).run("sess-1", "Session 1", NOW, "wi-parent");
  db.prepare(
    `INSERT INTO terminal_sessions (id, title, state, started_at)
     VALUES (?, ?, 'running', ?)`
  ).run("sess-2", "Session 2", NOW);

  // Circular FK the other direction: work_items.active_session_id → sessions.id (SET NULL)
  db.prepare(`UPDATE work_items SET active_session_id = ? WHERE id = ?`).run("sess-2", "wi-parent");

  db.prepare(
    `INSERT INTO task_session_links (id, work_item_id, session_id, role, created_at)
     VALUES (?, ?, ?, 'primary', ?)`
  ).run("link-1", "wi-parent", "sess-1", NOW);

  // comments table exists if migration 002 has been applied. Seed a row if so.
  const hasComments = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='comments'`)
    .get();
  if (hasComments) {
    db.prepare(
      `INSERT INTO comments (id, work_item_id, body, author_type, created_at, updated_at)
       VALUES (?, ?, ?, 'user', ?, ?)`
    ).run("cmt-1", "wi-parent", "hello", NOW, NOW);
  }

  // artifacts — one work-item-scoped, one epic-scoped, one unscoped
  db.prepare(
    `INSERT INTO artifacts (id, work_item_id, epic_id, artifact_type, title, created_at)
     VALUES (?, ?, NULL, 'note', ?, ?)`
  ).run("art-wi", "wi-parent", "wi artifact", NOW);
  db.prepare(
    `INSERT INTO artifacts (id, work_item_id, epic_id, artifact_type, title, created_at)
     VALUES (?, NULL, ?, 'note', ?, ?)`
  ).run("art-epic", "epic-1", "epic artifact", NOW);
  db.prepare(
    `INSERT INTO artifacts (id, work_item_id, epic_id, artifact_type, title, created_at)
     VALUES (?, NULL, NULL, 'note', ?, ?)`
  ).run("art-orphan", "orphan artifact", NOW);

  // activity_events — one per entity_type we care about
  const insertEvent = db.prepare(
    `INSERT INTO activity_events (id, event_type, entity_type, entity_id, source_type, actor_type, occurred_at, payload_json)
     VALUES (?, ?, ?, ?, 'system', 'system', ?, '{}')`
  );
  insertEvent.run("ev-wi", "wi.created", "work_item", "wi-parent", NOW);
  insertEvent.run("ev-epic", "epic.created", "epic", "epic-1", NOW);
  insertEvent.run("ev-init", "init.created", "initiative", "init-1", NOW);
  insertEvent.run("ev-agent", "agent.created", "agent", "agent-1", NOW);
  insertEvent.run("ev-sys", "system.started", "system", null, NOW);

  // ingest_files
  db.prepare(
    `INSERT INTO ingest_files (id, file_path, file_name, sha256, ingest_status, processed_at)
     VALUES (?, ?, ?, 'abc', 'processed', ?)`
  ).run("ing-1", "/tmp/f.json", "f.json", NOW);
}

function count(db: Database.Database, table: string, where = ""): number {
  const sql = `SELECT COUNT(*) AS n FROM ${table} ${where}`.trim();
  return (db.prepare(sql).get() as { n: number }).n;
}

function defaultArgs(overrides: Partial<Args> = {}): Args {
  return { scope: "tasks", agents: false, ingestFiles: false, yes: true, dryRun: false, ...overrides };
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("scope=tasks: deletes work_items and dependents, keeps epics/initiatives/agents/sessions/ingest", () => {
  const { db, cleanup } = freshDb();
  try {
    seedFixtures(db);
    const counts = wipeDb(defaultArgs({ scope: "tasks" }), db);

    // Reported counts. Note: SQLite's .changes reports only top-level deletes,
    // not rows removed via ON DELETE CASCADE. wi-parent cascades to wi-child,
    // so the reported count is 2 (wi-parent + wi-orphan), even though 3 rows
    // actually leave the table — asserted below via the empty-table check.
    assertEqual(counts.work_items, 2, "work_items reported count (cascaded rows not counted)");
    assertEqual(counts.activity_events, 1, "activity_events count (only work_item events)");
    assertEqual(counts.artifacts, 1, "artifacts count (only work-item-scoped)");

    // Rows actually deleted
    assertEqual(count(db, "work_items"), 0, "work_items table empty");
    assertEqual(count(db, "work_item_tags"), 0, "work_item_tags cascaded");
    assertEqual(count(db, "reviews"), 0, "reviews cascaded");
    assertEqual(count(db, "task_session_links"), 0, "task_session_links cascaded");

    // Artifacts: epic-scoped and unscoped kept
    assertEqual(count(db, "artifacts"), 2, "epic-scoped + unscoped artifacts kept");
    assertEqual(
      count(db, "artifacts", "WHERE id = 'art-wi'"),
      0,
      "work-item artifact deleted"
    );
    assertEqual(
      count(db, "artifacts", "WHERE id = 'art-epic'"),
      1,
      "epic artifact kept"
    );

    // Activity events: only work_item events removed
    assertEqual(count(db, "activity_events"), 4, "non-work_item events kept");
    assertEqual(
      count(db, "activity_events", "WHERE entity_type = 'work_item'"),
      0,
      "work_item events deleted"
    );

    // Rows kept
    assertEqual(count(db, "epics"), 2, "epics kept");
    assertEqual(count(db, "initiatives"), 1, "initiatives kept");
    assertEqual(count(db, "agents"), 1, "agents kept");
    assertEqual(count(db, "terminal_sessions"), 2, "sessions kept (both rows survive)");
    assertEqual(count(db, "ingest_files"), 1, "ingest_files kept");

    // FK fix: sessions.primary_work_item_id cleared so work_items delete succeeds
    assertEqual(
      count(db, "terminal_sessions", "WHERE primary_work_item_id IS NOT NULL"),
      0,
      "sessions.primary_work_item_id cleared for all rows"
    );
  } finally {
    cleanup();
  }
});

test("scope=epics: deletes epics, sets work_items.epic_id=NULL, keeps work_items themselves", () => {
  const { db, cleanup } = freshDb();
  try {
    seedFixtures(db);
    const counts = wipeDb(defaultArgs({ scope: "epics" }), db);

    assertEqual(counts.epics, 2, "epics count");
    assertEqual(counts.artifacts, 1, "artifacts count (only epic-scoped)");
    assertEqual(counts.activity_events, 1, "activity_events count (only epic events)");

    // Epics gone
    assertEqual(count(db, "epics"), 0, "epics table empty");

    // Work items survive with epic_id NULL (FK ON DELETE SET NULL)
    assertEqual(count(db, "work_items"), 3, "work_items kept");
    assertEqual(
      count(db, "work_items", "WHERE epic_id IS NULL"),
      3,
      "all work_items' epic_id set to NULL"
    );

    // Artifacts: work-item-scoped and unscoped kept
    assertEqual(count(db, "artifacts"), 2, "non-epic artifacts kept");
    assertEqual(
      count(db, "artifacts", "WHERE id = 'art-epic'"),
      0,
      "epic artifact deleted"
    );

    // Activity events: only epic events removed
    assertEqual(
      count(db, "activity_events", "WHERE entity_type = 'epic'"),
      0,
      "epic events deleted"
    );
    assertEqual(
      count(db, "activity_events", "WHERE entity_type = 'work_item'"),
      1,
      "work_item events kept"
    );

    // Other tables untouched
    assertEqual(count(db, "initiatives"), 1, "initiatives kept");
    assertEqual(count(db, "agents"), 1, "agents kept");
    assertEqual(count(db, "reviews"), 1, "reviews kept");
    assertEqual(count(db, "terminal_sessions"), 2, "sessions kept");
    assertEqual(count(db, "ingest_files"), 1, "ingest_files kept");
  } finally {
    cleanup();
  }
});

test("scope=all (default): deletes everything except agents", () => {
  const { db, cleanup } = freshDb();
  try {
    seedFixtures(db);
    wipeDb(defaultArgs({ scope: "all" }), db);

    assertEqual(count(db, "work_items"), 0, "work_items gone");
    assertEqual(count(db, "work_item_tags"), 0, "tags gone");
    assertEqual(count(db, "reviews"), 0, "reviews gone");
    assertEqual(count(db, "task_session_links"), 0, "session links gone");
    assertEqual(count(db, "artifacts"), 0, "all artifacts gone");
    assertEqual(count(db, "epics"), 0, "epics gone");
    assertEqual(count(db, "initiatives"), 0, "initiatives gone");
    assertEqual(count(db, "terminal_sessions"), 0, "sessions gone");
    assertEqual(count(db, "activity_events"), 0, "all events gone");
    assertEqual(count(db, "ingest_files"), 0, "ingest_files gone");

    // Agents preserved by default
    assertEqual(count(db, "agents"), 1, "agents kept by default");
  } finally {
    cleanup();
  }
});

test("scope=all with --agents: also wipes agents table", () => {
  const { db, cleanup } = freshDb();
  try {
    seedFixtures(db);
    const counts = wipeDb(defaultArgs({ scope: "all", agents: true }), db);

    assertEqual(counts.agents, 1, "agents count reported");
    assertEqual(count(db, "agents"), 0, "agents table empty");
  } finally {
    cleanup();
  }
});

test("scope=tasks on empty DB: no errors, zero counts", () => {
  const { db, cleanup } = freshDb();
  try {
    const counts = wipeDb(defaultArgs({ scope: "tasks" }), db);
    assertEqual(counts.work_items, 0, "zero work_items deleted");
    assertEqual(counts.artifacts, 0, "zero artifacts deleted");
    assertEqual(counts.activity_events, 0, "zero events deleted");
  } finally {
    cleanup();
  }
});

test("dry run: reports counts but rolls back — no rows are changed", () => {
  const { db, cleanup } = freshDb();
  try {
    seedFixtures(db);

    const before = {
      work_items: count(db, "work_items"),
      epics: count(db, "epics"),
      sessions: count(db, "terminal_sessions"),
      sessions_linked: count(db, "terminal_sessions", "WHERE primary_work_item_id IS NOT NULL"),
      events: count(db, "activity_events"),
      ingest: count(db, "ingest_files"),
    };

    const counts = wipeDb(defaultArgs({ scope: "all", agents: true, dryRun: true }), db);

    // Counts reflect what *would* have been deleted.
    if (!counts.work_items || counts.work_items < 1) {
      throw new Error(`dry run should report non-zero work_items count, got ${counts.work_items}`);
    }
    assertEqual(counts.epics, 2, "would-delete epics reported");
    assertEqual(counts.terminal_sessions_unlinked, 1, "would-clear sessions reported");

    // But nothing was actually changed.
    assertEqual(count(db, "work_items"), before.work_items, "work_items unchanged");
    assertEqual(count(db, "epics"), before.epics, "epics unchanged");
    assertEqual(count(db, "terminal_sessions"), before.sessions, "sessions unchanged");
    assertEqual(
      count(db, "terminal_sessions", "WHERE primary_work_item_id IS NOT NULL"),
      before.sessions_linked,
      "session FK still linked",
    );
    assertEqual(count(db, "activity_events"), before.events, "events unchanged");
    assertEqual(count(db, "ingest_files"), before.ingest, "ingest_files unchanged");
  } finally {
    cleanup();
  }
});

test("scope=tasks is idempotent: running twice is safe", () => {
  const { db, cleanup } = freshDb();
  try {
    seedFixtures(db);
    wipeDb(defaultArgs({ scope: "tasks" }), db);
    const second = wipeDb(defaultArgs({ scope: "tasks" }), db);
    assertEqual(second.work_items, 0, "second run deletes nothing");
    assertEqual(count(db, "epics"), 2, "epics still present");
  } finally {
    cleanup();
  }
});

test("wipeIngestFiles: clears processed/rejected/attachments, reports counts", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wipe-ingest-"));
  try {
    const base = path.join(tmpRoot, "data", "ingest");
    for (const sub of ["processed", "rejected", "attachments"]) {
      fs.mkdirSync(path.join(base, sub), { recursive: true });
    }
    fs.writeFileSync(path.join(base, "processed", "a.json"), "{}");
    fs.writeFileSync(path.join(base, "processed", "b.json"), "{}");
    fs.writeFileSync(path.join(base, "rejected", "c.json"), "{}");
    // attachments left empty

    const counts = wipeIngestFiles(tmpRoot);

    assertEqual(counts.processed, 2, "processed count");
    assertEqual(counts.rejected, 1, "rejected count");
    assertEqual(counts.attachments, 0, "attachments count");

    assertEqual(fs.readdirSync(path.join(base, "processed")).length, 0, "processed dir empty");
    assertEqual(fs.readdirSync(path.join(base, "rejected")).length, 0, "rejected dir empty");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("wipeIngestFiles: missing dirs report zero without error", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wipe-ingest-missing-"));
  try {
    const counts = wipeIngestFiles(tmpRoot);
    assertEqual(counts.processed, 0, "processed zero");
    assertEqual(counts.rejected, 0, "rejected zero");
    assertEqual(counts.attachments, 0, "attachments zero");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── Run ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
    passed++;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ ${t.name}\n      ${msg.split("\n").join("\n      ")}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
