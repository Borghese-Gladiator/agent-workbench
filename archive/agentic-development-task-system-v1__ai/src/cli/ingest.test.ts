/**
 * Unit tests for src/cli/ingest.ts
 *
 * Run: npx tsx src/cli/ingest.test.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseArgs,
  slugify,
  buildTaskEnvelope,
  buildEpicEnvelope,
  buildCommentEnvelope,
  buildWorkItemDeleteEnvelope,
  buildEpicDeleteEnvelope,
  buildCommentDeleteEnvelope,
  buildInitiativeDeleteEnvelope,
  buildSetAwaitingEnvelope,
  validateEnvelope,
  writeToInbox,
  run,
  runBatch,
  type IngestResult,
} from "./ingest.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function assertThrows(fn: () => void, pattern: string, message: string): void {
  try {
    fn();
    failed++;
    console.error(`  ❌ ${message} (did not throw)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(pattern)) {
      passed++;
      console.log(`  ✅ ${message}`);
    } else {
      failed++;
      console.error(`  ❌ ${message} (threw "${msg}", expected "${pattern}")`);
    }
  }
}

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-test-"));
  fs.mkdirSync(path.join(dir, "data", "ingest", "inbox"), { recursive: true });
  return dir;
}

// ── parseArgs ───────────────────────────────────────────────────────────────

console.log("\n── parseArgs ──");

{
  const { subcommand, flags } = parseArgs(["task", "--title", "Hello", "--kind", "bug"]);
  assert(subcommand === "task", "extracts subcommand");
  assert(flags["title"] === "Hello", "extracts --title value");
  assert(flags["kind"] === "bug", "extracts --kind value");
}

{
  const { flags } = parseArgs(["epic", "--title", "My epic", "--verbose"]);
  assert(flags["title"] === "My epic", "flag with value");
  assert(flags["verbose"] === "true", "boolean flag (no value)");
}

assertThrows(
  () => parseArgs([]),
  "Usage",
  "throws on empty args",
);

assertThrows(
  () => parseArgs(["--title", "oops"]),
  "Usage",
  "throws when first arg is a flag",
);

{
  const { subcommand, positional, flags } = parseArgs(["batch", "{\"tasks\":[]}", "--source", "cli"]);
  assert(subcommand === "batch", "positional: extracts subcommand");
  assert(positional.length === 1 && positional[0] === "{\"tasks\":[]}", "positional: captures leading non-flag token");
  assert(flags["source"] === "cli", "positional: still parses trailing flags");
}

{
  const { positional } = parseArgs(["batch", "-"]);
  assert(positional[0] === "-", "positional: accepts '-' literal");
}

{
  const { positional } = parseArgs(["task", "--title", "x"]);
  assert(positional.length === 0, "positional: empty when only flags follow subcommand");
}

// ── slugify ─────────────────────────────────────────────────────────────────

console.log("\n── slugify ──");

assert(slugify("Fix login bug") === "fix-login-bug", "basic slugify");
assert(slugify("Fix: login & signup (v2.0) [urgent]") === "fix-login-signup-v2-0-urgent", "strips special chars");
assert(slugify("  leading and trailing  ") === "leading-and-trailing", "trims whitespace slugs");
assert(slugify("A".repeat(100)) === "a".repeat(60), "truncates to 60 chars");
assert(slugify("---hello---") === "hello", "strips leading/trailing dashes");
assert(slugify("UPPER CASE") === "upper-case", "lowercases");

// ── buildTaskEnvelope ───────────────────────────────────────────────────────

console.log("\n── buildTaskEnvelope ──");

{
  const { envelope, entityId, slug } = buildTaskEnvelope({ title: "Fix login bug" });
  assert(envelope.event_type === "work_item.created", "event_type");
  assert(envelope.actor.type === "agent", "default actor type");
  assert(envelope.actor.id === "claude-code", "default actor id");
  assert(envelope.source === "claude-skill", "default source");

  const p = envelope.payload as Record<string, unknown>;
  assert(p.work_item_id === entityId, "payload work_item_id matches returned entityId");
  assert(p.kind === "task", "default kind");
  assert(p.status === "triage", "default status");
  assert(p.body === "", "default body");
  assert(p.epic_id === null, "default epic_id");
  assert(p.parent_id === null, "default parent_id");
  assert(Array.isArray(p.tags) && (p.tags as string[]).length === 0, "default tags");
  assert(slug === "fix-login-bug", "slug from title");
}

{
  const { envelope } = buildTaskEnvelope({
    title: "Crash",
    kind: "bug",
    "epic-id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    tags: "auth,backend, frontend",
    "acceptance-criteria": "No crashes",
    "branch-name": "fix/crash",
    "assigned-agent-id": "executor-01",
    "actor-id": "planner-01",
    "actor-type": "user",
    source: "test",
  });
  const p = envelope.payload as Record<string, unknown>;
  assert(p.kind === "bug", "kind=bug from flag");
  assert(p.epic_id === "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", "epic_id from flag");
  assert((p.tags as string[]).length === 3, "tags parsed and trimmed");
  assert((p.tags as string[])[2] === "frontend", "tag whitespace trimmed");
  assert(p.acceptance_criteria === "No crashes", "acceptance_criteria");
  assert(p.branch_name === "fix/crash", "branch_name");
  assert(p.assigned_agent_id === "executor-01", "assigned_agent_id");
  assert(envelope.actor.id === "planner-01", "custom actor-id");
  assert(envelope.actor.type === "user", "custom actor-type");
  assert(envelope.source === "test", "custom source");
}

assertThrows(
  () => buildTaskEnvelope({}),
  "--title is required",
  "throws when title missing",
);

// ── buildEpicEnvelope ───────────────────────────────────────────────────────

console.log("\n── buildEpicEnvelope ──");

{
  const { envelope, entityId, slug } = buildEpicEnvelope({ title: "Auth overhaul" });
  assert(envelope.event_type === "epic.created", "event_type");
  const p = envelope.payload as Record<string, unknown>;
  assert(p.epic_id === entityId, "payload epic_id matches returned entityId");
  assert(p.title === "Auth overhaul", "title");
  assert(p.description === null, "default description");
  assert(p.initiative_id === null, "default initiative_id");
  assert(slug === "auth-overhaul", "slug");
}

{
  const initId = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
  const { envelope } = buildEpicEnvelope({
    title: "Platform v2",
    description: "Major rewrite",
    "initiative-id": initId,
  });
  const p = envelope.payload as Record<string, unknown>;
  assert(p.description === "Major rewrite", "description from flag");
  assert(p.initiative_id === initId, "initiative_id from flag");
}

assertThrows(
  () => buildEpicEnvelope({}),
  "--title is required",
  "throws when title missing",
);

// ── buildCommentEnvelope ────────────────────────────────────────────────────

console.log("\n── buildCommentEnvelope ──");

{
  const workItemId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const { envelope, entityId, slug } = buildCommentEnvelope({
    "work-item-id": workItemId,
    body: "Looks good",
  });
  assert(envelope.event_type === "comment.created", "event_type");
  assert(envelope.actor.type === "agent", "default actor type");
  assert(envelope.actor.id === "claude-code", "default actor id");

  const p = envelope.payload as Record<string, unknown>;
  assert(p.comment_id === entityId, "payload comment_id matches returned entityId");
  assert(p.work_item_id === workItemId, "payload work_item_id");
  assert(p.body === "Looks good", "payload body");
  assert(slug.startsWith("for-"), "slug references work item");
}

assertThrows(
  () => buildCommentEnvelope({ body: "orphan" }),
  "--work-item-id is required",
  "throws when work-item-id missing",
);

assertThrows(
  () => buildCommentEnvelope({ "work-item-id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" }),
  "--body is required",
  "throws when body missing",
);

// ── validateEnvelope ────────────────────────────────────────────────────────

console.log("\n── validateEnvelope ──");

{
  const { envelope } = buildTaskEnvelope({ title: "Valid task" });
  // Should not throw
  validateEnvelope(envelope);
  passed++;
  console.log("  ✅ valid task envelope passes");
}

{
  const { envelope } = buildEpicEnvelope({ title: "Valid epic" });
  validateEnvelope(envelope);
  passed++;
  console.log("  ✅ valid epic envelope passes");
}

{
  const { envelope } = buildCommentEnvelope({
    "work-item-id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    body: "Valid comment",
  });
  validateEnvelope(envelope);
  passed++;
  console.log("  ✅ valid comment envelope passes");
}

assertThrows(
  () => validateEnvelope({ event_id: "not-a-uuid", event_type: "", occurred_at: "", source: "", actor: {}, payload: {} }),
  "Envelope validation failed",
  "rejects invalid envelope",
);

assertThrows(
  () => {
    const { envelope } = buildTaskEnvelope({ title: "test" });
    (envelope as Record<string, unknown>).event_type = "bogus.event";
    validateEnvelope(envelope);
  },
  "No payload schema",
  "rejects unknown event_type",
);

// ── writeToInbox ────────────────────────────────────────────────────────────

console.log("\n── writeToInbox ──");

{
  const tmpDir = makeTmpDir();
  const { envelope, entityId, slug } = buildTaskEnvelope({ title: "Inbox test" });
  const result = writeToInbox(envelope, "task", entityId, slug, tmpDir);

  assert(fs.existsSync(result.file), "file created on disk");
  assert(result.entity_id === entityId, "result entity_id matches");
  assert(result.event_type === "work_item.created", "result event_type");
  assert(result.file.includes("task-inbox-test-"), "filename has entity type and slug");

  const written = JSON.parse(fs.readFileSync(result.file, "utf-8"));
  assert(written.event_type === "work_item.created", "written JSON is valid");

  fs.rmSync(tmpDir, { recursive: true });
}

// ── run (end-to-end) ────────────────────────────────────────────────────────

console.log("\n── run (end-to-end) ──");

{
  const tmpDir = makeTmpDir();
  const result = run(["task", "--title", "E2E task", "--kind", "bug", "--tags", "a,b"], tmpDir) as IngestResult;
  assert(result.event_type === "work_item.created", "task run returns correct event_type");
  assert(fs.existsSync(result.file), "task file written");

  const envelope = JSON.parse(fs.readFileSync(result.file, "utf-8"));
  assert(envelope.payload.kind === "bug", "task payload kind=bug");
  assert(envelope.payload.tags.length === 2, "task payload tags parsed");

  fs.rmSync(tmpDir, { recursive: true });
}

{
  const tmpDir = makeTmpDir();
  const result = run(["epic", "--title", "E2E epic", "--description", "Desc"], tmpDir) as IngestResult;
  assert(result.event_type === "epic.created", "epic run returns correct event_type");
  assert(fs.existsSync(result.file), "epic file written");

  const envelope = JSON.parse(fs.readFileSync(result.file, "utf-8"));
  assert(envelope.payload.description === "Desc", "epic payload description");

  fs.rmSync(tmpDir, { recursive: true });
}

{
  const tmpDir = makeTmpDir();
  const workItemId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const result = run(
    ["comment", "--work-item-id", workItemId, "--body", "Hello from CLI"],
    tmpDir,
  ) as IngestResult;
  assert(result.event_type === "comment.created", "comment run returns correct event_type");
  assert(fs.existsSync(result.file), "comment file written");
  assert(result.file.includes("comment-for-"), "comment filename prefix");

  const envelope = JSON.parse(fs.readFileSync(result.file, "utf-8"));
  assert(envelope.payload.work_item_id === workItemId, "comment payload work_item_id");
  assert(envelope.payload.body === "Hello from CLI", "comment payload body");

  fs.rmSync(tmpDir, { recursive: true });
}

assertThrows(
  () => run([], "/tmp"),
  "Usage",
  "run throws on empty args",
);

assertThrows(
  () => run(["bogus"], "/tmp"),
  "Unknown subcommand",
  "run throws on unknown subcommand",
);

assertThrows(
  () => run(["task"], "/tmp"),
  "--title is required",
  "run throws when title missing",
);

// ── Delete envelope builders ────────────────────────────────────────────────

console.log("\n── Delete envelope builders ──");

type DeleteCase = {
  label: string;
  builder: (flags: Record<string, string>) => { envelope: Record<string, unknown>; entityId: string; slug: string };
  flagKey: string;
  payloadKey: string;
  eventType: string;
  missingError: string;
};

const sampleUuid = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

const deleteCases: DeleteCase[] = [
  {
    label: "delete-task",
    builder: buildWorkItemDeleteEnvelope,
    flagKey: "work-item-id",
    payloadKey: "work_item_id",
    eventType: "work_item.deleted",
    missingError: "--work-item-id is required",
  },
  {
    label: "delete-epic",
    builder: buildEpicDeleteEnvelope,
    flagKey: "epic-id",
    payloadKey: "epic_id",
    eventType: "epic.deleted",
    missingError: "--epic-id is required",
  },
  {
    label: "delete-comment",
    builder: buildCommentDeleteEnvelope,
    flagKey: "comment-id",
    payloadKey: "comment_id",
    eventType: "comment.deleted",
    missingError: "--comment-id is required",
  },
  {
    label: "delete-initiative",
    builder: buildInitiativeDeleteEnvelope,
    flagKey: "initiative-id",
    payloadKey: "initiative_id",
    eventType: "initiative.deleted",
    missingError: "--initiative-id is required",
  },
];

for (const c of deleteCases) {
  assertThrows(
    () => c.builder({}),
    c.missingError,
    `${c.label} throws when ${c.flagKey} missing`,
  );

  const { envelope, entityId, slug } = c.builder({ [c.flagKey]: sampleUuid });
  assert(envelope.event_type === c.eventType, `${c.label} event_type = ${c.eventType}`);
  assert(entityId === sampleUuid, `${c.label} entityId = input id`);
  const payload = envelope.payload as Record<string, unknown>;
  assert(payload[c.payloadKey] === sampleUuid, `${c.label} payload.${c.payloadKey} matches`);
  assert(slug === `deleted-${sampleUuid.slice(0, 8)}`, `${c.label} slug prefixed with "deleted-"`);

  // Delete envelopes must validate against the payload schema.
  validateEnvelope(envelope);
  passed++;
  console.log(`  ✅ ${c.label} envelope validates against schema`);
}

// Delete runs end-to-end through run()
{
  const tmpDir = makeTmpDir();
  const result = run(["delete-task", "--work-item-id", sampleUuid], tmpDir) as IngestResult;
  assert(result.event_type === "work_item.deleted", "run delete-task event_type");
  assert(fs.existsSync(result.file), "run delete-task file written");
  assert(result.file.includes("task-deleted-"), "run delete-task filename prefix");
  fs.rmSync(tmpDir, { recursive: true });
}

assertThrows(
  () => run(["delete-task"], "/tmp"),
  "--work-item-id is required",
  "run delete-task throws when id missing",
);

// ── runBatch ────────────────────────────────────────────────────────────────

console.log("\n── runBatch ──");

// Batch with just tasks (no epic)
{
  const tmpDir = makeTmpDir();
  const payload = {
    tasks: [
      { title: "First task" },
      { title: "Second task", tags: ["backend"] },
    ],
  };
  const result = runBatch(payload, tmpDir);
  assert(result.epic === null, "batch without epic returns epic: null");
  assert(result.tasks.length === 2, "batch writes both tasks");
  assert(result.summary.epics === 0, "summary.epics=0");
  assert(result.summary.tasks === 2, "summary.tasks=2");
  assert(typeof result.batch_id === "string" && result.batch_id.length > 0, "batch_id is generated");
  for (const t of result.tasks) {
    assert(fs.existsSync(t.file), `file written: ${path.basename(t.file)}`);
  }
  fs.rmSync(tmpDir, { recursive: true });
}

// Batch with epic generates epic first; tasks inherit generated epic_id
{
  const tmpDir = makeTmpDir();
  const payload = {
    epic: { title: "Poker scaffold", description: "Multi-phase" },
    tasks: [
      { title: "Scaffold repo", tags: ["setup"] },
      { title: "Install deps" },
    ],
  };
  const result = runBatch(payload, tmpDir);
  assert(result.epic !== null, "batch with epic returns epic result");
  assert(result.epic?.event_type === "epic.created", "epic event_type");
  assert(result.tasks.length === 2, "two task files written");

  // Verify tasks were stamped with the generated epic_id
  const epicId = result.epic!.entity_id;
  for (const t of result.tasks) {
    const written = JSON.parse(fs.readFileSync(t.file, "utf-8"));
    assert(written.payload.epic_id === epicId, `task epic_id equals generated epic's UUID`);
  }
  fs.rmSync(tmpDir, { recursive: true });
}

// Top-level epic_id is used when epic: block not present
{
  const tmpDir = makeTmpDir();
  const existingEpicId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const payload = {
    epic_id: existingEpicId,
    tasks: [{ title: "Inherit epic" }],
  };
  const result = runBatch(payload, tmpDir);
  const written = JSON.parse(fs.readFileSync(result.tasks[0].file, "utf-8"));
  assert(written.payload.epic_id === existingEpicId, "task inherits top-level epic_id");
  fs.rmSync(tmpDir, { recursive: true });
}

// Row-level epic_id overrides defaults.epic_id and top-level epic_id
{
  const tmpDir = makeTmpDir();
  const defaultEpic = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const rowEpic = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const payload = {
    defaults: { epic_id: defaultEpic },
    tasks: [
      { title: "Uses default" },
      { title: "Overrides", epic_id: rowEpic },
    ],
  };
  const result = runBatch(payload, tmpDir);
  const w0 = JSON.parse(fs.readFileSync(result.tasks[0].file, "utf-8"));
  const w1 = JSON.parse(fs.readFileSync(result.tasks[1].file, "utf-8"));
  assert(w0.payload.epic_id === defaultEpic, "task 0 uses defaults.epic_id");
  assert(w1.payload.epic_id === rowEpic, "task 1 row-level epic_id wins");
  fs.rmSync(tmpDir, { recursive: true });
}

// defaults.tags unioned with row tags, order preserved, dupes removed
{
  const tmpDir = makeTmpDir();
  const payload = {
    defaults: { tags: ["setup", "shared"] },
    tasks: [{ title: "merge tags", tags: ["backend", "shared"] }],
  };
  const result = runBatch(payload, tmpDir);
  const written = JSON.parse(fs.readFileSync(result.tasks[0].file, "utf-8"));
  assert(
    JSON.stringify(written.payload.tags) === JSON.stringify(["setup", "shared", "backend"]),
    "tags merged: defaults first, row added, dupes removed",
  );
  fs.rmSync(tmpDir, { recursive: true });
}

// Empty tasks array rejected
assertThrows(
  () => runBatch({ tasks: [] }, "/tmp"),
  "Batch payload validation failed",
  "runBatch rejects empty tasks",
);

// Unknown top-level keys rejected (typo catch)
assertThrows(
  () => runBatch({ taks: [{ title: "x" }] }, "/tmp"),
  "Batch payload validation failed",
  "runBatch rejects unknown top-level key",
);

// _-prefixed row keys are accepted and discarded
{
  const tmpDir = makeTmpDir();
  const payload = {
    tasks: [{ title: "annotated", _phase: "A — skeleton", _note: "internal" }],
  };
  const result = runBatch(payload, tmpDir);
  const written = JSON.parse(fs.readFileSync(result.tasks[0].file, "utf-8"));
  assert(written.payload.title === "annotated", "task built despite _-prefixed keys");
  assert(!("_phase" in written.payload), "_phase not written into payload");
  assert(!("_note" in written.payload), "_note not written into payload");
  fs.rmSync(tmpDir, { recursive: true });
}

// Atomicity: invalid row → zero files written
{
  const tmpDir = makeTmpDir();
  const inboxDir = path.join(tmpDir, "data", "ingest", "inbox");
  const payload = {
    tasks: [
      { title: "good one" },
      { title: "" }, // invalid: empty title
      { title: "another good" },
    ],
  };
  let threw = false;
  try {
    runBatch(payload, tmpDir);
  } catch {
    threw = true;
  }
  assert(threw, "runBatch throws on invalid row");
  const files = fs.readdirSync(inboxDir);
  assert(files.length === 0, "atomicity: no files written when any row invalid");
  fs.rmSync(tmpDir, { recursive: true });
}

// Error aggregation: multiple invalid rows reported together
{
  const payload = {
    tasks: [
      { title: "" },
      { title: "ok" },
      { title: "" },
      { title: "" },
    ],
  };
  try {
    runBatch(payload, "/tmp");
    failed++;
    console.error("  ❌ error aggregation (did not throw)");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hit0 = msg.includes("tasks.0") || msg.includes("tasks[0]");
    const hit2 = msg.includes("tasks.2") || msg.includes("tasks[2]");
    const hit3 = msg.includes("tasks.3") || msg.includes("tasks[3]");
    if (hit0 && hit2 && hit3) {
      passed++;
      console.log("  ✅ error aggregation: all three invalid rows named");
    } else {
      failed++;
      console.error(`  ❌ error aggregation (got: ${msg})`);
    }
  }
}

// End-to-end via run(["batch", json], ...)
{
  const tmpDir = makeTmpDir();
  const payload = {
    epic: { title: "E2E epic" },
    tasks: [{ title: "E2E task" }],
  };
  const result = run(["batch", JSON.stringify(payload)], tmpDir) as {
    batch_id: string;
    epic: { file: string; entity_id: string; event_type: string; sort_order: number } | null;
    tasks: { file: string; entity_id: string; event_type: string; sort_order: number; lane: string | null; depends_on_id: string | null }[];
    summary: { epics: number; tasks: number; lanes: string[] };
  };
  assert(result.summary.epics === 1, "run batch writes epic");
  assert(result.summary.tasks === 1, "run batch writes task");
  assert(fs.existsSync(result.epic!.file), "run batch epic file on disk");
  assert(fs.existsSync(result.tasks[0].file), "run batch task file on disk");
  fs.rmSync(tmpDir, { recursive: true });
}

// run(["batch", "<invalid json>"]) surfaces a clean parse error
assertThrows(
  () => run(["batch", "{not json"], "/tmp"),
  "Invalid JSON payload",
  "run batch reports JSON parse errors cleanly",
);

// ── ordering / lane / depends_on ────────────────────────────────────────────

console.log("\n── ordering / lane / depends_on ──");

// Default sort sequence: 0, 10, 20
{
  const tmpDir = makeTmpDir();
  const result = runBatch(
    { tasks: [{ title: "a" }, { title: "b" }, { title: "c" }] },
    tmpDir,
  );
  const orders = result.tasks.map((t) => t.sort_order);
  assert(JSON.stringify(orders) === JSON.stringify([0, 10, 20]), "default sort sequence 0,10,20");
  for (const t of result.tasks) {
    const written = JSON.parse(fs.readFileSync(t.file, "utf-8"));
    assert(written.payload.sort_order === t.sort_order, `envelope has matching sort_order=${t.sort_order}`);
    assert(written.payload.batch_id === result.batch_id, "envelope batch_id propagated");
  }
  fs.rmSync(tmpDir, { recursive: true });
}

// sort_start + sort_step custom
{
  const tmpDir = makeTmpDir();
  const result = runBatch(
    { sort_start: 100, sort_step: 5, tasks: [{ title: "a" }, { title: "b" }] },
    tmpDir,
  );
  assert(result.tasks[0].sort_order === 100, "sort_start=100 honored");
  assert(result.tasks[1].sort_order === 105, "sort_step=5 honored");
  fs.rmSync(tmpDir, { recursive: true });
}

// Row-level sort_order overrides computed
{
  const tmpDir = makeTmpDir();
  const result = runBatch(
    { tasks: [{ title: "a", sort_order: 50 }, { title: "b" }] },
    tmpDir,
  );
  assert(result.tasks[0].sort_order === 50, "row sort_order wins");
  assert(result.tasks[1].sort_order === 10, "other rows keep computed sequence");
  fs.rmSync(tmpDir, { recursive: true });
}

// Lane from defaults propagates; row overrides
{
  const tmpDir = makeTmpDir();
  const result = runBatch(
    {
      defaults: { lane: "backend" },
      tasks: [{ title: "a" }, { title: "b", lane: "frontend" }],
    },
    tmpDir,
  );
  assert(result.tasks[0].lane === "backend", "task 0 inherits defaults.lane");
  assert(result.tasks[1].lane === "frontend", "task 1 row lane wins");
  const written0 = JSON.parse(fs.readFileSync(result.tasks[0].file, "utf-8"));
  const written1 = JSON.parse(fs.readFileSync(result.tasks[1].file, "utf-8"));
  assert(written0.payload.lane === "backend", "envelope 0 lane=backend");
  assert(written1.payload.lane === "frontend", "envelope 1 lane=frontend");
  fs.rmSync(tmpDir, { recursive: true });
}

// summary.lanes contains distinct, sorted set
{
  const tmpDir = makeTmpDir();
  const result = runBatch(
    {
      tasks: [
        { title: "a", lane: "backend" },
        { title: "b", lane: "frontend" },
        { title: "c", lane: "backend" },
      ],
    },
    tmpDir,
  );
  assert(
    JSON.stringify(result.summary.lanes) === JSON.stringify(["backend", "frontend"]),
    "summary.lanes sorted and distinct",
  );
  fs.rmSync(tmpDir, { recursive: true });
}

// depends_on integer resolves to earlier task's UUID
{
  const tmpDir = makeTmpDir();
  const result = runBatch(
    { tasks: [{ title: "a" }, { title: "b", depends_on: 0 }] },
    tmpDir,
  );
  assert(result.tasks[1].depends_on_id === result.tasks[0].entity_id, "depends_on 0 resolved to task 0 uuid");
  const written = JSON.parse(fs.readFileSync(result.tasks[1].file, "utf-8"));
  assert(written.payload.depends_on_id === result.tasks[0].entity_id, "envelope depends_on_id matches");
  fs.rmSync(tmpDir, { recursive: true });
}

// depends_on forward reference rejected
assertThrows(
  () => runBatch({ tasks: [{ title: "a", depends_on: 1 }, { title: "b" }] }, "/tmp"),
  "forward reference",
  "forward reference dep rejected",
);

// depends_on self reference rejected
assertThrows(
  () => runBatch({ tasks: [{ title: "a", depends_on: 0 }] }, "/tmp"),
  "self reference",
  "self reference dep rejected",
);

// depends_on out of range rejected
assertThrows(
  () => runBatch({ tasks: [{ title: "a" }, { title: "b", depends_on: 5 }] }, "/tmp"),
  "out of range",
  "out-of-range depends_on rejected",
);

// depends_on as UUID passthrough
{
  const tmpDir = makeTmpDir();
  const externalUuid = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const result = runBatch(
    { tasks: [{ title: "a", depends_on: externalUuid }] },
    tmpDir,
  );
  assert(result.tasks[0].depends_on_id === externalUuid, "UUID passthrough preserved");
  fs.rmSync(tmpDir, { recursive: true });
}

// depends_on non-uuid string rejected
assertThrows(
  () => runBatch({ tasks: [{ title: "a", depends_on: "not-a-uuid" }] }, "/tmp"),
  "neither a UUID nor a batch index",
  "non-UUID string depends_on rejected",
);

// Parallel siblings: both point at index 0
{
  const tmpDir = makeTmpDir();
  const result = runBatch(
    {
      tasks: [
        { title: "predecessor" },
        { title: "sibling-A", depends_on: 0 },
        { title: "sibling-B", depends_on: 0 },
      ],
    },
    tmpDir,
  );
  assert(result.tasks[1].depends_on_id === result.tasks[0].entity_id, "sibling A points at 0");
  assert(result.tasks[2].depends_on_id === result.tasks[0].entity_id, "sibling B points at 0");
  fs.rmSync(tmpDir, { recursive: true });
}

// Epic propagates batch_id
{
  const tmpDir = makeTmpDir();
  const result = runBatch(
    { epic: { title: "E", sort_order: 42 }, tasks: [{ title: "a" }] },
    tmpDir,
  );
  assert(result.epic !== null, "epic built");
  const written = JSON.parse(fs.readFileSync(result.epic!.file, "utf-8"));
  assert(written.payload.batch_id === result.batch_id, "epic envelope batch_id matches");
  assert(written.payload.sort_order === 42, "epic envelope sort_order honored");
  assert(result.epic!.sort_order === 42, "epic result sort_order honored");
  fs.rmSync(tmpDir, { recursive: true });
}

// task subcommand --sort-order / --lane / --depends-on-id flags
{
  const tmpDir = makeTmpDir();
  const depUuid = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";
  const res = run(
    [
      "task",
      "--title", "flag test",
      "--sort-order", "42",
      "--lane", "infra",
      "--depends-on-id", depUuid,
    ],
    tmpDir,
  ) as IngestResult;
  const written = JSON.parse(fs.readFileSync(res.file, "utf-8"));
  assert(written.payload.sort_order === 42, "task --sort-order threaded");
  assert(written.payload.lane === "infra", "task --lane threaded");
  assert(written.payload.depends_on_id === depUuid, "task --depends-on-id threaded");
  fs.rmSync(tmpDir, { recursive: true });
}

// task subcommand --sort-order non-integer rejected
assertThrows(
  () => run(["task", "--title", "x", "--sort-order", "abc"], "/tmp"),
  "must be an integer",
  "task --sort-order non-integer rejected",
);

// ── buildSetAwaitingEnvelope ────────────────────────────────────────────────

console.log("\n── buildSetAwaitingEnvelope ──");

{
  const workItemId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const { envelope, entityId, slug } = buildSetAwaitingEnvelope({
    "work-item-id": workItemId,
    awaiting: "true",
  });
  assert(envelope.event_type === "work_item.updated", "event_type work_item.updated");
  assert(entityId === workItemId, "entityId matches work item id");
  const p = envelope.payload as Record<string, unknown>;
  const updates = p.updates as Record<string, unknown>;
  assert(p.work_item_id === workItemId, "payload work_item_id");
  assert(updates.awaiting_input === 1, "updates.awaiting_input === 1 for true");
  assert(slug.includes("awaiting-on-"), "slug reflects on state");
  validateEnvelope(envelope);
  passed++;
  console.log("  ✅ set-awaiting true envelope validates");
}

{
  const { envelope } = buildSetAwaitingEnvelope({
    "work-item-id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    awaiting: "false",
  });
  const p = envelope.payload as Record<string, unknown>;
  const updates = p.updates as Record<string, unknown>;
  assert(updates.awaiting_input === 0, "updates.awaiting_input === 0 for false");
}

assertThrows(
  () => buildSetAwaitingEnvelope({ awaiting: "true" }),
  "--work-item-id is required",
  "set-awaiting throws when work-item-id missing",
);

assertThrows(
  () => buildSetAwaitingEnvelope({ "work-item-id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" }),
  "--awaiting is required",
  "set-awaiting throws when awaiting missing",
);

assertThrows(
  () => buildSetAwaitingEnvelope({
    "work-item-id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    awaiting: "maybe",
  }),
  "must be \"true\" or \"false\"",
  "set-awaiting rejects non-boolean",
);

// set-awaiting via run() writes to inbox
{
  const tmpDir = makeTmpDir();
  const workItemId = "b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const res = run(
    ["set-awaiting", "--work-item-id", workItemId, "--awaiting", "true"],
    tmpDir,
  ) as IngestResult;
  assert(res.event_type === "work_item.updated", "run() returns work_item.updated event_type");
  assert(res.entity_id === workItemId, "run() returns work item id");
  assert(fs.existsSync(res.file), "inbox file created");
  const written = JSON.parse(fs.readFileSync(res.file, "utf-8"));
  assert(written.payload.updates.awaiting_input === 1, "written payload has awaiting_input=1");
  fs.rmSync(tmpDir, { recursive: true });
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(40)}`);

process.exit(failed > 0 ? 1 : 0);
