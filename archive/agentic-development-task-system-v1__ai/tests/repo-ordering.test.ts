/**
 * Repo-level unit tests for v0.3.7 ordering / lane / dependency fields.
 *
 * Run: npx tsx tests/repo-ordering.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must be set before importing the connection module so the singleton lands
// on a private tmp DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-ordering-'));
const DB_PATH = path.join(tmp, 'taskboard.sqlite');
process.env.TASKBOARD_DB_PATH = DB_PATH;

// Dynamic imports so env var is set before connection.ts evaluates its
// DEFAULT_DB_PATH constant.
const { v4: uuid } = await import('uuid');
const { getDb, closeDb } = await import('@server/db/connection.js');
const { runMigrations } = await import('@server/db/migrate.js');
const { insertWorkItem, listWorkItems, updateWorkItemStatus } =
  await import('@server/db/repositories/work-items.js');
const { insertEpic } = await import('@server/db/repositories/epics.js');

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const db = getDb(DB_PATH);
runMigrations(db);

const now = new Date().toISOString();
const epicId = uuid();
insertEpic({
  id: epicId, initiative_id: null, slug: 'e', title: 'Epic',
  description: null, status: 'open', color: 'blue',
  sort_order: 0, batch_id: null, created_at: now, updated_at: now,
});

// Insert 5 work items out of dependency order — chain-c first, predecessor last.
// Asserts that the listWorkItems SQL derivation tolerates a missing predecessor
// at insert time and re-resolves once rows are present.
const ids = {
  pred: uuid(),
  sibA: uuid(),
  sibB: uuid(),
  chainC: uuid(),
  tail: uuid(),
};

function insert(overrides: {
  id: string; title: string; sort_order: number;
  lane?: string | null; depends_on_id?: string | null; status?: string;
  batch_id?: string | null;
}): void {
  insertWorkItem({
    id: overrides.id, epic_id: epicId, parent_id: null, slug: '',
    kind: 'task', title: overrides.title, body: '',
    status: overrides.status ?? 'triage', category: 'work',
    awaiting_input: 0, active_session_id: null,
    assigned_agent_id: null, reviewer_agent_id: null,
    branch_name: null, acceptance_criteria: null, result_summary: null,
    sort_order: overrides.sort_order,
    lane: overrides.lane ?? null,
    batch_id: overrides.batch_id ?? null,
    depends_on_id: overrides.depends_on_id ?? null,
    created_by: 'test', created_at: now, updated_at: now,
    completed_at: null, archived_at: null,
  });
}

const batchId = uuid();
// Insert chain-c FIRST with its depends_on_id pointing at sibB which doesn't exist yet.
insert({ id: ids.chainC, title: 'Chain C', sort_order: 30, lane: 'backend', depends_on_id: ids.sibB, batch_id: batchId });
insert({ id: ids.sibA, title: 'Sibling A', sort_order: 10, lane: 'frontend', depends_on_id: ids.pred, batch_id: batchId });
insert({ id: ids.tail, title: 'Tail', sort_order: 40, lane: 'backend', batch_id: batchId });
insert({ id: ids.sibB, title: 'Sibling B', sort_order: 20, lane: 'backend', depends_on_id: ids.pred, batch_id: batchId });
insert({ id: ids.pred, title: 'Predecessor', sort_order: 0, lane: 'backend', batch_id: batchId });

console.log('\n── Out-of-order insert with soft depends_on_id ──');
const items = listWorkItems();
check(items.length === 5, `5 items listed (got ${items.length})`);
check(items[0].title === 'Predecessor', 'sort_order 0 first');
check(items[4].title === 'Tail', 'sort_order 40 last');
check(items.every((i) => i.batch_id === batchId), 'all items carry batch_id');
check(items.every((i) => i.lane !== null), 'all items have a lane');

const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
check(byTitle['Predecessor'].ready_to_start === 1, 'Predecessor ready (no dep)');
check(byTitle['Tail'].ready_to_start === 1, 'Tail ready (no dep)');
check(byTitle['Sibling A'].ready_to_start === 0, 'Sibling A waiting');
check(byTitle['Sibling A'].blocked_by_title === 'Predecessor', 'Sibling A blocked_by=Predecessor');
check(byTitle['Chain C'].ready_to_start === 0, 'Chain C waiting');
check(byTitle['Chain C'].blocked_by_title === 'Sibling B', 'Chain C blocked_by=Sibling B');

console.log('\n── Predecessor done → siblings unblock, Chain C still waits ──');
updateWorkItemStatus(ids.pred, 'done');
const after1 = Object.fromEntries(listWorkItems().map((i) => [i.title, i]));
check(after1['Sibling A'].ready_to_start === 1, 'Sibling A unblocks');
check(after1['Sibling B'].ready_to_start === 1, 'Sibling B unblocks');
check(after1['Chain C'].ready_to_start === 0, 'Chain C still waiting on Sibling B');

console.log('\n── Sibling B done → Chain C unblocks ──');
updateWorkItemStatus(ids.sibB, 'done');
const after2 = Object.fromEntries(listWorkItems().map((i) => [i.title, i]));
check(after2['Chain C'].ready_to_start === 1, 'Chain C unblocks after Sibling B done');

console.log('\n── in_progress / done items never ready_to_start ──');
updateWorkItemStatus(ids.sibA, 'in_progress');
const after3 = Object.fromEntries(listWorkItems().map((i) => [i.title, i]));
check(after3['Sibling A'].ready_to_start === 0, 'Sibling A in_progress: ready_to_start=0');
check(after3['Predecessor'].ready_to_start === 0, 'Predecessor done: ready_to_start=0');

console.log('\n── lane filter returns subset ──');
const backendOnly = listWorkItems({ lane: 'backend' });
check(backendOnly.every((i) => i.lane === 'backend'), 'lane filter returns only backend');
check(backendOnly.length === 4, `4 backend items (got ${backendOnly.length})`);

console.log('\n── batch filter returns subset ──');
const byBatch = listWorkItems({ batchId });
check(byBatch.length === 5, 'batch filter returns all 5 from this batch');

console.log('\n── Soft dep: null predecessor → waiting with blocked_by_title=null ──');
const orphan = uuid();
insert({ id: orphan, title: 'Orphan', sort_order: 100, depends_on_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' });
const orphanRow = listWorkItems().find((i) => i.title === 'Orphan')!;
check(orphanRow.ready_to_start === 0, 'Orphan waiting on missing predecessor');
check(orphanRow.blocked_by_title === null, 'Orphan blocked_by_title=null when predecessor absent');

closeDb();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(40));
process.exit(failed > 0 ? 1 : 0);
