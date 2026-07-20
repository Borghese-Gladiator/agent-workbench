import { runMigrations } from '@server/db/migrate.js';
import { getDb, closeDb } from '@server/db/connection.js';
import { startWatcher, stopWatcher } from '@server/ingest/watcher.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// Fresh DB
const dbPath = path.join(ROOT, 'data/db/taskboard.sqlite');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = getDb();
runMigrations(db);
startWatcher([ROOT]);

// Copy invalid fixture
setTimeout(() => {
  const src = path.join(ROOT, 'tests/fixtures/issue-proposed-invalid.json');
  const dest = path.join(ROOT, 'data/ingest/inbox/issue-proposed-invalid.json');
  fs.copyFileSync(src, dest);
  console.log('[test] Copied invalid fixture to inbox');
}, 2000);

setTimeout(async () => {
  const issues = db.prepare('SELECT id FROM issues').all();
  const ingest = db.prepare('SELECT file_name, ingest_status, rejection_reason FROM ingest_files').all();
  const inbox = fs.readdirSync(path.join(ROOT, 'data/ingest/inbox'));
  const rejected = fs.readdirSync(path.join(ROOT, 'data/ingest/rejected'));

  console.log('\n=== RESULTS ===');
  console.log('Issues (should be 0):', issues.length);
  console.log('Ingest files:', JSON.stringify(ingest, null, 2));
  console.log('Inbox (should be empty):', inbox);
  console.log('Rejected (should have 1):', rejected);

  const pass = issues.length === 0 && inbox.length === 0 && rejected.length >= 1;
  console.log(pass ? '\n✅ REJECTION TEST PASSED' : '\n❌ REJECTION TEST FAILED');

  await stopWatcher();
  closeDb();
  process.exit(pass ? 0 : 1);
}, 6000);
