import { runMigrations } from '@server/db/migrate.js';
import { getDb, closeDb } from '@server/db/connection.js';
import { startWatcher, stopWatcher, getWatcherStatus } from '@server/ingest/watcher.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// Fresh DB
const dbPath = path.join(ROOT, 'data/db/taskboard.sqlite');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = getDb();
runMigrations(db);

// Start watcher
startWatcher([ROOT]);

// Wait for ready, then copy file
setTimeout(() => {
  const src = path.join(ROOT, 'tests/fixtures/issue-proposed-valid.json');
  const dest = path.join(ROOT, 'data/ingest/inbox/issue-proposed-valid.json');
  fs.copyFileSync(src, dest);
  console.log('[test] Copied fixture to inbox');
}, 2000);

// Check results after processing
setTimeout(async () => {
  const issues = db.prepare('SELECT id, title, status FROM issues').all();
  const drafts = db.prepare('SELECT id, title FROM issue_task_drafts').all();
  const events = db.prepare('SELECT id, event_type, entity_type FROM activity_events').all();
  const ingest = db.prepare('SELECT id, file_name, ingest_status FROM ingest_files').all();
  const inbox = fs.readdirSync(path.join(ROOT, 'data/ingest/inbox'));
  const processed = fs.readdirSync(path.join(ROOT, 'data/ingest/processed'));

  console.log('\n=== RESULTS ===');
  console.log('Issues:', JSON.stringify(issues, null, 2));
  console.log('Task Drafts:', JSON.stringify(drafts, null, 2));
  console.log('Events:', JSON.stringify(events, null, 2));
  console.log('Ingest files:', JSON.stringify(ingest, null, 2));
  console.log('Inbox remaining:', inbox);
  console.log('Processed:', processed);
  console.log('Watcher status:', JSON.stringify(getWatcherStatus()));

  const pass = issues.length === 1 && drafts.length >= 1 && inbox.length === 0 && processed.length >= 1;
  console.log(pass ? '\n✅ ALL CHECKS PASSED' : '\n❌ CHECKS FAILED');

  await stopWatcher();
  closeDb();
  process.exit(pass ? 0 : 1);
}, 6000);
