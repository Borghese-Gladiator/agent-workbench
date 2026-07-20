import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { getDb, closeDb } from "./connection.js";
import { runMigrations } from "./migrate.js";


const ROOT = process.cwd();
const db = getDb();
runMigrations(db);

// Wipe tables this seed writes to, so `npm run seed` is idempotent.
// work_items cascades handle work_item_tags, reviews, task_session_links, comments, sub-tasks.
// terminal_sessions.primary_work_item_id is NO ACTION, but this seed doesn't populate sessions.
db.exec(`
  DELETE FROM artifacts;
  DELETE FROM activity_events;
  DELETE FROM work_items;
  DELETE FROM epics;
  DELETE FROM initiatives;
  DELETE FROM agents;
`);

const now = new Date().toISOString();

// ── Ingest JSON helper ──────────────────────────────────────────────────────
// Writes a valid ingest envelope to data/ingest/processed/ so the seed data
// has a corresponding audit trail, just like real ingested events would.

const processedDir = path.join(ROOT, "data", "ingest", "processed");
fs.mkdirSync(processedDir, { recursive: true });

let envelopeCount = 0;

function writeEnvelope(
  eventType: string,
  payload: Record<string, unknown>,
  entityType: string,
  slug: string,
): void {
  const envelope = {
    event_id: uuid(),
    event_type: eventType,
    occurred_at: now,
    source: "seed",
    actor: { type: "system", id: "seed-script" },
    payload,
  };
  const timestamp = now.replace(/[:.]/g, "-");
  const shortId = (payload.work_item_id ?? payload.epic_id ?? uuid()) as string;
  const fileName = `${timestamp}__${entityType}-${slug}-${shortId.slice(0, 8)}.json`;
  fs.writeFileSync(path.join(processedDir, fileName), JSON.stringify(envelope, null, 2) + "\n");
  envelopeCount++;
}

// === Initiatives ===
const initIds = [uuid(), uuid()];
const insertInit = db.prepare(`INSERT INTO initiatives (id, slug, name, description, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
insertInit.run(initIds[0], "developer-tooling", "Developer Tooling", "Build and improve internal developer tools", "active", 0, now, now);
insertInit.run(initIds[1], "personal-projects", "Personal Projects", "Side projects and learning exercises", "active", 1, now, now);

// === Epics ===
const epicIds = [uuid(), uuid(), uuid(), uuid()];
const insertEpic = db.prepare(`INSERT INTO epics (id, initiative_id, slug, title, description, status, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const epics = [
  { id: epicIds[0], initId: initIds[0], slug: "task-management-system", title: "Task Management System", desc: "Build an agentic task management system with hierarchy support", status: "in_progress", color: "blue", sort: 0 },
  { id: epicIds[1], initId: initIds[0], slug: "terminal-integration", title: "Terminal Integration", desc: "Embed a tmux-backed terminal emulator in the UI", status: "open", color: "green", sort: 1 },
  { id: epicIds[2], initId: initIds[0], slug: "bug-bash-q2", title: "Bug Bash Q2", desc: "Fix high-priority bugs from Q1 feedback", status: "open", color: "red", sort: 2 },
  { id: epicIds[3], initId: initIds[1], slug: "lean4-prover", title: "Lean 4 Theorem Prover", desc: "Learn Lean 4 by formalizing basic number theory proofs", status: "open", color: "purple", sort: 0 },
];

for (const e of epics) {
  insertEpic.run(e.id, e.initId, e.slug, e.title, e.desc, e.status, e.color, e.sort, now, now);
  writeEnvelope("epic.created", { epic_id: e.id, title: e.title, description: e.desc, initiative_id: e.initId }, "epic", e.slug);
}

// === Agents ===
const agentIds = [uuid(), uuid(), uuid()];
const insertAgent = db.prepare(`INSERT INTO agents (id, name, kind, description, default_instructions, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
insertAgent.run(agentIds[0], "planner-01", "planner", "Plans and decomposes work into tasks", null, 1, now, now);
insertAgent.run(agentIds[1], "executor-01", "executor", "Implements code changes", null, 1, now, now);
insertAgent.run(agentIds[2], "reviewer-01", "reviewer", "Reviews code for correctness and style", null, 1, now, now);

// === Work Items ===
const insertItem = db.prepare(`
  INSERT INTO work_items (id, epic_id, parent_id, slug, kind, title, body, status, category, awaiting_input, active_session_id, assigned_agent_id, reviewer_agent_id, branch_name, acceptance_criteria, result_summary, sort_order, created_by, created_at, updated_at, completed_at, archived_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTag = db.prepare(`INSERT OR IGNORE INTO work_item_tags (work_item_id, tag) VALUES (?, ?)`);
const insertArtifact = db.prepare(`INSERT INTO artifacts (id, work_item_id, epic_id, session_id, artifact_type, title, path, mime_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

interface WorkItem {
  id: string;
  epicId: string | null;
  parentId: string | null;
  slug: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  category: string;
  agentId: string | null;
  reviewerId: string | null;
  branch: string | null;
  acceptance: string | null;
  result: string | null;
  sort: number;
  tags: string[];
}

function insertWorkItem(item: WorkItem): void {
  const completed = item.status === "done" ? now : null;
  insertItem.run(
    item.id, item.epicId, item.parentId, item.slug, item.kind, item.title, item.body, item.status, item.category,
    0, null, item.agentId, item.reviewerId, item.branch, item.acceptance, item.result, item.sort,
    "seed", now, now, completed, null,
  );
  for (const tag of item.tags) insertTag.run(item.id, tag);

  writeEnvelope("work_item.created", {
    work_item_id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    status: item.status,
    epic_id: item.epicId,
    parent_id: item.parentId,
    assigned_agent_id: item.agentId,
    branch_name: item.branch,
    acceptance_criteria: item.acceptance,
    tags: item.tags,
  }, item.kind, item.slug);
}

// Task 1: Hierarchy data model (done, with subtasks)
const t1 = uuid();
insertWorkItem({ id: t1, epicId: epicIds[0], parentId: null, slug: "implement-hierarchy-data-model", kind: "task", title: "Implement hierarchy data model", body: "Create Initiative > Epic > WorkItem schema with proper foreign keys and constraints", status: "done", category: "work", agentId: agentIds[1], reviewerId: agentIds[2], branch: "feat/hierarchy-model", acceptance: "Schema supports full hierarchy with cascading deletes", result: "Schema deployed and seeded", sort: 0, tags: ["schema", "backend", "database"] });

const t1s1 = uuid();
insertWorkItem({ id: t1s1, epicId: epicIds[0], parentId: t1, slug: "create-schema-sql", kind: "task", title: "Create schema.sql with all tables", body: "Write the DDL for initiatives, epics, work_items, and supporting tables", status: "done", category: "work", agentId: agentIds[1], reviewerId: null, branch: null, acceptance: null, result: null, sort: 0, tags: ["schema"] });

const t1s2 = uuid();
insertWorkItem({ id: t1s2, epicId: epicIds[0], parentId: t1, slug: "write-repository-layer", kind: "task", title: "Write repository layer for all tables", body: "Create TypeScript repository files with prepared statements for CRUD operations", status: "done", category: "work", agentId: agentIds[1], reviewerId: null, branch: null, acceptance: null, result: null, sort: 1, tags: ["backend"] });

const t1s3 = uuid();
insertWorkItem({ id: t1s3, epicId: epicIds[0], parentId: t1, slug: "add-migration-system", kind: "task", title: "Add migration system", body: "Implement schema_migrations table and incremental migration runner", status: "done", category: "work", agentId: agentIds[1], reviewerId: null, branch: null, acceptance: null, result: null, sort: 2, tags: ["backend"] });

// Plan artifact for T1
insertArtifact.run(uuid(), t1, epicIds[0], null, "file", "Schema Design Plan", "data/task_data/developer-tooling/task-management-system/implement-hierarchy-data-model/plan.md", "text/markdown",
  JSON.stringify({ content: "# Schema Design Plan\n\n## Goals\n- Support full hierarchy: Initiative > Epic > WorkItem > Sub-task\n- Cascading deletes for parent-child relationships\n- Indexes on all foreign keys and frequently filtered columns\n\n## Tables\n1. `initiatives` — top-level grouping\n2. `epics` — groups of related work\n3. `work_items` — tasks and bugs with parent_id for sub-tasks\n4. `work_item_tags` — many-to-many tags\n5. Supporting: agents, reviews, artifacts, activity_events, terminal_sessions\n\n## Status\nComplete — all tables created and seeded." }),
  now);

// Task 2: Kanban board UI (in_progress, with subtasks)
const t2 = uuid();
insertWorkItem({ id: t2, epicId: epicIds[0], parentId: null, slug: "build-kanban-board-ui", kind: "task", title: "Build kanban board UI", body: "Drag-and-drop board with status columns, epic grouping, and filter controls", status: "in_progress", category: "work", agentId: agentIds[1], reviewerId: null, branch: "feat/kanban-board", acceptance: "Board supports drag-and-drop between all status columns", result: null, sort: 1, tags: ["frontend", "ui", "dnd"] });

const t2s1 = uuid();
insertWorkItem({ id: t2s1, epicId: epicIds[0], parentId: t2, slug: "implement-dnd-columns", kind: "task", title: "Implement drag-and-drop columns", body: "Use @dnd-kit to enable dragging cards between status columns", status: "done", category: "work", agentId: agentIds[1], reviewerId: null, branch: null, acceptance: null, result: null, sort: 0, tags: ["frontend"] });

const t2s2 = uuid();
insertWorkItem({ id: t2s2, epicId: epicIds[0], parentId: t2, slug: "add-epic-grouping", kind: "task", title: "Add epic grouping mode", body: "Group cards by epic with collapsible sections", status: "in_progress", category: "work", agentId: agentIds[1], reviewerId: null, branch: null, acceptance: null, result: null, sort: 1, tags: ["frontend"] });

const t2s3 = uuid();
insertWorkItem({ id: t2s3, epicId: epicIds[0], parentId: t2, slug: "add-filter-controls", kind: "task", title: "Add filter bar with dropdowns", body: "Status, kind, epic, category, tag filters", status: "ready", category: "work", agentId: null, reviewerId: null, branch: null, acceptance: null, result: null, sort: 2, tags: ["frontend"] });

// Plan artifact for T2
insertArtifact.run(uuid(), t2, epicIds[0], null, "file", "Kanban Board Plan", "data/task_data/developer-tooling/task-management-system/build-kanban-board-ui/plan.md", "text/markdown",
  JSON.stringify({ content: "# Kanban Board Plan\n\n## Layout\n5 columns: Triage | Ready | In Progress | In Review | Done\n\n## Features\n- Drag-and-drop with @dnd-kit\n- Epic grouping (collapsible)\n- Category border coloring (blue=work, green=personal)\n- Awaiting input badge\n- Filter bar: status, kind, epic, category, tag\n\n## Tech\n- @dnd-kit/core + @dnd-kit/sortable\n- React Query for server state\n- shadcn/ui components" }),
  now);

// Task 3: Terminal emulator (triage)
const t3 = uuid();
insertWorkItem({ id: t3, epicId: epicIds[1], parentId: null, slug: "integrate-xterm-terminal", kind: "task", title: "Integrate xterm.js terminal emulator", body: "Full-page terminal tab with tmux session management and WebSocket relay", status: "triage", category: "work", agentId: null, reviewerId: null, branch: null, acceptance: null, result: null, sort: 0, tags: ["terminal", "frontend", "websocket"] });

insertArtifact.run(uuid(), t3, epicIds[1], null, "file", "Terminal Integration Plan", "data/task_data/developer-tooling/terminal-integration/integrate-xterm-terminal/plan.md", "text/markdown",
  JSON.stringify({ content: "# Terminal Integration Plan\n\n## Architecture\n- Server: tmux session manager + WebSocket relay\n- Client: xterm.js with fit addon\n- Each work item in_progress gets its own tmux session\n\n## Phases\n1. WebSocket server setup\n2. tmux manager (create/attach/kill)\n3. xterm.js client component\n4. Auto-session on status transition\n5. Awaiting input detection" }),
  now);

// Task 4: Bug — activity feed not updating
const t4 = uuid();
insertWorkItem({ id: t4, epicId: epicIds[2], parentId: null, slug: "activity-feed-not-updating", kind: "bug", title: "Activity feed not updating on status change", body: "Events are recorded in the database but the Activity tab doesn't refetch when a status change occurs from the Board.", status: "ready", category: "work", agentId: agentIds[1], reviewerId: null, branch: null, acceptance: null, result: null, sort: 0, tags: ["activity", "frontend", "polling"] });

// Task 5: Bug — DnD on touch
const t5 = uuid();
insertWorkItem({ id: t5, epicId: epicIds[2], parentId: null, slug: "dnd-fails-touch-devices", kind: "bug", title: "Drag-and-drop fails on touch devices", body: "PointerSensor activation distance is too low on mobile, causing accidental drags", status: "triage", category: "work", agentId: null, reviewerId: null, branch: null, acceptance: null, result: null, sort: 1, tags: ["ui"] });

// Task 6: Lean 4 (personal)
const t6 = uuid();
insertWorkItem({ id: t6, epicId: epicIds[3], parentId: null, slug: "prove-even-number-theorem", kind: "task", title: "Prove even number theorem in Lean 4", body: "Formalize and prove that the sum of two even numbers is even", status: "in_progress", category: "personal", agentId: null, reviewerId: null, branch: null, acceptance: null, result: null, sort: 0, tags: ["lean4", "math", "proofs"] });

const t6s1 = uuid();
insertWorkItem({ id: t6s1, epicId: epicIds[3], parentId: t6, slug: "define-even-predicate", kind: "task", title: "Define the Even predicate", body: "Create an inductive definition of evenness in Lean 4", status: "done", category: "personal", agentId: null, reviewerId: null, branch: null, acceptance: null, result: null, sort: 0, tags: ["lean4"] });

const t6s2 = uuid();
insertWorkItem({ id: t6s2, epicId: epicIds[3], parentId: t6, slug: "prove-sum-even", kind: "task", title: "Prove sum of two evens is even", body: "Use structural induction on the Even predicate", status: "in_progress", category: "personal", agentId: null, reviewerId: null, branch: null, acceptance: null, result: null, sort: 1, tags: ["lean4"] });

// Task 7: Update README (ungrouped)
const t7 = uuid();
insertWorkItem({ id: t7, epicId: null, parentId: null, slug: "update-readme-v010", kind: "task", title: "Update README for v0.1.0", body: "Document new hierarchy model and API changes", status: "triage", category: "work", agentId: null, reviewerId: null, branch: null, acceptance: null, result: null, sort: 0, tags: ["docs"] });

// === Activity Events ===
const insertEvent = db.prepare(`INSERT INTO activity_events (id, event_type, entity_type, entity_id, source_type, source_ref, actor_type, actor_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

insertEvent.run(uuid(), "epic.created", "epic", epicIds[0], "system", null, "user", null, now, JSON.stringify({ title: "Task Management System" }));
insertEvent.run(uuid(), "epic.created", "epic", epicIds[1], "system", null, "user", null, now, JSON.stringify({ title: "Terminal Integration" }));
insertEvent.run(uuid(), "epic.created", "epic", epicIds[2], "system", null, "user", null, now, JSON.stringify({ title: "Bug Bash Q2" }));
insertEvent.run(uuid(), "work_item.created", "work_item", t1, "system", null, "system", null, now, JSON.stringify({ kind: "task", title: "Implement hierarchy data model" }));
insertEvent.run(uuid(), "work_item.status_changed", "work_item", t1, "system", null, "agent", agentIds[1], now, JSON.stringify({ from: "in_progress", to: "done" }));
insertEvent.run(uuid(), "work_item.created", "work_item", t2, "system", null, "system", null, now, JSON.stringify({ kind: "task", title: "Build kanban board UI" }));
insertEvent.run(uuid(), "work_item.created", "work_item", t4, "system", null, "system", null, now, JSON.stringify({ kind: "bug", title: "Activity feed not updating on status change" }));
insertEvent.run(uuid(), "artifact.attached", "artifact", uuid(), "system", null, "agent", agentIds[1], now, JSON.stringify({ work_item_id: t1, title: "Schema Design Plan" }));

closeDb();
console.log(`[seed] Database seeded with sample data.`);
console.log(`[seed] Wrote ${envelopeCount} ingest envelopes to data/ingest/processed/`);
