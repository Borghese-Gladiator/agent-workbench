/**
 * Ingest CLI — creates tasks and epics by writing JSON envelopes to data/ingest/inbox/.
 *
 * This module exports the core logic as pure, testable functions.
 * The entry point is ingest.main.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import {
  IngestEnvelopeSchema,
  WorkItemCreatedPayloadSchema,
  EpicCreatedPayloadSchema,
  PayloadSchemaMap,
} from "@shared/schemas.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ParsedArgs {
  subcommand: string;
  positional: string[];
  flags: Record<string, string>;
}

export interface IngestResult {
  file: string;
  entity_id: string;
  event_type: string;
}

export interface BatchTaskResult extends IngestResult {
  sort_order: number;
  lane: string | null;
  depends_on_id: string | null;
}

export interface BatchEpicResult extends IngestResult {
  sort_order: number;
}

export interface BatchIngestResult {
  batch_id: string;
  epic: BatchEpicResult | null;
  tasks: BatchTaskResult[];
  summary: { epics: number; tasks: number; lanes: string[] };
}

// ── Arg parsing ─────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): ParsedArgs {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand.startsWith("--")) {
    throw new Error("Usage: ingest <task|epic|comment|batch|delete-task|delete-epic|delete-comment|delete-initiative> [options]");
  }

  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let seenFlag = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      seenFlag = true;
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else if (!seenFlag) {
      positional.push(arg);
    }
  }
  return { subcommand, positional, flags };
}

// ── Slug helper ─────────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ── Envelope builders ───────────────────────────────────────────────────────

export function buildTaskEnvelope(flags: Record<string, string>) {
  const title = flags["title"];
  if (!title) throw new Error("--title is required for task subcommand");

  const workItemId = uuid();
  const eventId = uuid();

  const payload: Record<string, unknown> = {
    work_item_id: workItemId,
    kind: flags["kind"] ?? "task",
    title,
    body: flags["body"] ?? "",
    status: flags["status"] ?? "triage",
    epic_id: flags["epic-id"] ?? null,
    parent_id: flags["parent-id"] ?? null,
    assigned_agent_id: flags["assigned-agent-id"] ?? null,
    branch_name: flags["branch-name"] ?? null,
    acceptance_criteria: flags["acceptance-criteria"] ?? null,
    tags: flags["tags"] ? flags["tags"].split(",").map((t) => t.trim()) : [],
  };

  if (flags["sort-order"] !== undefined) {
    const parsed = parseInt(flags["sort-order"], 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`--sort-order must be an integer (got: "${flags["sort-order"]}")`);
    }
    payload.sort_order = parsed;
  }
  if (flags["lane"] !== undefined) {
    payload.lane = flags["lane"];
  }
  if (flags["batch-id"] !== undefined) {
    payload.batch_id = flags["batch-id"];
  }
  if (flags["depends-on-id"] !== undefined) {
    payload.depends_on_id = flags["depends-on-id"];
  }

  const envelope = {
    event_id: eventId,
    event_type: "work_item.created" as const,
    occurred_at: new Date().toISOString(),
    source: flags["source"] ?? "claude-skill",
    actor: {
      type: flags["actor-type"] ?? "agent",
      id: flags["actor-id"] ?? "claude-code",
    },
    payload,
  };

  return { envelope, entityId: workItemId, slug: slugify(title) };
}

export function buildCommentEnvelope(flags: Record<string, string>) {
  const workItemId = flags["work-item-id"];
  const body = flags["body"];
  if (!workItemId) throw new Error("--work-item-id is required for comment subcommand");
  if (!body) throw new Error("--body is required for comment subcommand");

  const commentId = uuid();
  const eventId = uuid();

  const payload: Record<string, unknown> = {
    comment_id: commentId,
    work_item_id: workItemId,
    body,
  };

  const envelope = {
    event_id: eventId,
    event_type: "comment.created" as const,
    occurred_at: new Date().toISOString(),
    source: flags["source"] ?? "claude-skill",
    actor: {
      type: flags["actor-type"] ?? "agent",
      id: flags["actor-id"] ?? "claude-code",
    },
    payload,
  };

  return { envelope, entityId: commentId, slug: `for-${workItemId.slice(0, 8)}` };
}

export function buildEpicEnvelope(flags: Record<string, string>) {
  const title = flags["title"];
  if (!title) throw new Error("--title is required for epic subcommand");

  const epicId = uuid();
  const eventId = uuid();

  const payload: Record<string, unknown> = {
    epic_id: epicId,
    title,
    description: flags["description"] ?? null,
    initiative_id: flags["initiative-id"] ?? null,
  };

  if (flags["sort-order"] !== undefined) {
    const parsed = parseInt(flags["sort-order"], 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`--sort-order must be an integer (got: "${flags["sort-order"]}")`);
    }
    payload.sort_order = parsed;
  }
  if (flags["batch-id"] !== undefined) {
    payload.batch_id = flags["batch-id"];
  }

  const envelope = {
    event_id: eventId,
    event_type: "epic.created" as const,
    occurred_at: new Date().toISOString(),
    source: flags["source"] ?? "claude-skill",
    actor: {
      type: flags["actor-type"] ?? "agent",
      id: flags["actor-id"] ?? "claude-code",
    },
    payload,
  };

  return { envelope, entityId: epicId, slug: slugify(title) };
}

// ── Delete envelope builders ────────────────────────────────────────────────

function buildDeleteEnvelope(
  eventType: string,
  idKey: string,
  payloadKey: string,
  actorType: string,
  actorId: string,
  source: string,
  entityId: string,
): Record<string, unknown> {
  return {
    event_id: uuid(),
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    source,
    actor: { type: actorType, id: actorId },
    payload: { [payloadKey]: entityId },
  };
}

export function buildWorkItemDeleteEnvelope(flags: Record<string, string>) {
  const workItemId = flags["work-item-id"];
  if (!workItemId) throw new Error("--work-item-id is required for delete-task subcommand");

  const envelope = buildDeleteEnvelope(
    "work_item.deleted",
    "work-item-id",
    "work_item_id",
    flags["actor-type"] ?? "agent",
    flags["actor-id"] ?? "claude-code",
    flags["source"] ?? "claude-skill",
    workItemId,
  );
  return { envelope, entityId: workItemId, slug: `deleted-${workItemId.slice(0, 8)}` };
}

export function buildEpicDeleteEnvelope(flags: Record<string, string>) {
  const epicId = flags["epic-id"];
  if (!epicId) throw new Error("--epic-id is required for delete-epic subcommand");

  const envelope = buildDeleteEnvelope(
    "epic.deleted",
    "epic-id",
    "epic_id",
    flags["actor-type"] ?? "agent",
    flags["actor-id"] ?? "claude-code",
    flags["source"] ?? "claude-skill",
    epicId,
  );
  return { envelope, entityId: epicId, slug: `deleted-${epicId.slice(0, 8)}` };
}

export function buildCommentDeleteEnvelope(flags: Record<string, string>) {
  const commentId = flags["comment-id"];
  if (!commentId) throw new Error("--comment-id is required for delete-comment subcommand");

  const envelope = buildDeleteEnvelope(
    "comment.deleted",
    "comment-id",
    "comment_id",
    flags["actor-type"] ?? "agent",
    flags["actor-id"] ?? "claude-code",
    flags["source"] ?? "claude-skill",
    commentId,
  );
  return { envelope, entityId: commentId, slug: `deleted-${commentId.slice(0, 8)}` };
}

export function buildInitiativeDeleteEnvelope(flags: Record<string, string>) {
  const initiativeId = flags["initiative-id"];
  if (!initiativeId) throw new Error("--initiative-id is required for delete-initiative subcommand");

  const envelope = buildDeleteEnvelope(
    "initiative.deleted",
    "initiative-id",
    "initiative_id",
    flags["actor-type"] ?? "agent",
    flags["actor-id"] ?? "claude-code",
    flags["source"] ?? "claude-skill",
    initiativeId,
  );
  return { envelope, entityId: initiativeId, slug: `deleted-${initiativeId.slice(0, 8)}` };
}

// ── Set-awaiting envelope builder ───────────────────────────────────────────

export function buildSetAwaitingEnvelope(flags: Record<string, string>) {
  const workItemId = flags["work-item-id"];
  if (!workItemId) throw new Error("--work-item-id is required for set-awaiting subcommand");

  const raw = flags["awaiting"];
  if (raw === undefined) throw new Error("--awaiting is required for set-awaiting subcommand (true|false)");
  const lowered = raw.toLowerCase();
  if (lowered !== "true" && lowered !== "false") {
    throw new Error(`--awaiting must be "true" or "false" (got "${raw}")`);
  }
  const awaitingInput = lowered === "true";

  const eventId = uuid();
  const envelope = {
    event_id: eventId,
    event_type: "work_item.updated" as const,
    occurred_at: new Date().toISOString(),
    source: flags["source"] ?? "claude-skill",
    actor: {
      type: flags["actor-type"] ?? "agent",
      id: flags["actor-id"] ?? "claude-code",
    },
    payload: {
      work_item_id: workItemId,
      updates: { awaiting_input: awaitingInput ? 1 : 0 },
    },
  };

  const slug = `awaiting-${awaitingInput ? "on" : "off"}-${workItemId.slice(0, 8)}`;
  return { envelope, entityId: workItemId, slug };
}

// ── Validate ────────────────────────────────────────────────────────────────

export function validateEnvelope(envelope: Record<string, unknown>): void {
  const envelopeResult = IngestEnvelopeSchema.safeParse(envelope);
  if (!envelopeResult.success) {
    throw new Error(`Envelope validation failed: ${envelopeResult.error.issues.map((i) => i.message).join(", ")}`);
  }

  const eventType = envelope.event_type as string;
  const payloadSchema = PayloadSchemaMap[eventType];
  if (!payloadSchema) {
    throw new Error(`No payload schema for event_type: "${eventType}"`);
  }

  const payloadResult = payloadSchema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    throw new Error(`Payload validation failed: ${payloadResult.error.issues.map((i) => i.message).join(", ")}`);
  }
}

// ── Write to inbox ──────────────────────────────────────────────────────────

export function writeToInbox(
  envelope: Record<string, unknown>,
  entityType: string,
  entityId: string,
  slug: string,
  rootDir: string,
): IngestResult {
  validateEnvelope(envelope);

  const inboxDir = path.join(rootDir, "data", "ingest", "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });

  const shortId = entityId.slice(0, 8);
  const fileName = `${entityType}-${slug}-${shortId}.json`;
  const filePath = path.join(inboxDir, fileName);

  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2) + "\n");

  return {
    file: filePath,
    entity_id: entityId,
    event_type: envelope.event_type as string,
  };
}

// ── Batch payload ───────────────────────────────────────────────────────────

const ActorTypeSchema = z.enum(["user", "agent", "system"]);

const DefaultsSchema = z
  .object({
    kind: z.enum(["task", "bug"]).optional(),
    status: z.string().optional(),
    epic_id: z.string().optional(),
    parent_id: z.string().optional(),
    tags: z.array(z.string()).optional(),
    lane: z.string().max(40).optional(),
    sort_order: z.number().int().optional(),
    actor_id: z.string().optional(),
    actor_type: ActorTypeSchema.optional(),
    source: z.string().optional(),
  })
  .strict();

const EpicInputSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    initiative_id: z.string().nullable().optional(),
    sort_order: z.number().int().optional(),
  })
  .strict();

// Allow keys starting with "_" for user annotations (e.g. "_phase").
const TaskInputSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().optional(),
    kind: z.enum(["task", "bug"]).optional(),
    status: z.string().optional(),
    epic_id: z.string().optional(),
    parent_id: z.string().optional(),
    tags: z.array(z.string()).optional(),
    acceptance_criteria: z.string().optional(),
    branch_name: z.string().optional(),
    assigned_agent_id: z.string().optional(),
    lane: z.string().max(40).optional(),
    sort_order: z.number().int().optional(),
    depends_on: z.union([z.string(), z.number().int()]).optional(),
    actor_id: z.string().optional(),
    actor_type: ActorTypeSchema.optional(),
    source: z.string().optional(),
  })
  .catchall(z.unknown())
  .superRefine((val, ctx) => {
    const allowed = new Set([
      "title",
      "body",
      "kind",
      "status",
      "epic_id",
      "parent_id",
      "tags",
      "acceptance_criteria",
      "branch_name",
      "assigned_agent_id",
      "lane",
      "sort_order",
      "depends_on",
      "actor_id",
      "actor_type",
      "source",
    ]);
    for (const key of Object.keys(val)) {
      if (!allowed.has(key) && !key.startsWith("_")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown key "${key}" (use "_"-prefix for annotations)`,
          path: [key],
        });
      }
    }
  });

export const BatchPayloadSchema = z
  .object({
    defaults: DefaultsSchema.optional(),
    epic: EpicInputSchema.optional(),
    epic_id: z.string().optional(),
    tasks: z.array(TaskInputSchema).min(1),
    sort_start: z.number().int().optional(),
    sort_step: z.number().int().positive().optional(),
    lane: z.string().max(40).optional(),
  })
  .strict();

export type BatchPayload = z.infer<typeof BatchPayloadSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── runBatch ────────────────────────────────────────────────────────────────

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  ${path}: ${issue.message}`;
    })
    .join("\n");
}

// Convert a snake_case key to kebab-case to match the existing envelope
// builders' flag names (e.g. "epic_id" → "epic-id").
function snakeToKebab(key: string): string {
  return key.replace(/_/g, "-");
}

// Flatten a task row + defaults into the flat flags map the existing
// buildTaskEnvelope expects. Row values override defaults. Tags are unioned
// (defaults first, row second, dupes removed, order preserved).
function buildTaskFlags(
  row: Record<string, unknown>,
  defaults: Record<string, unknown> | undefined,
  effectiveEpicId: string | null,
  sortOrder: number,
  batchId: string,
  dependsOnId: string | null,
  topLevelLane: string | undefined,
): Record<string, string> {
  const flags: Record<string, string> = {};

  const mergedTags: string[] = [];
  const defaultTags = (defaults?.tags as string[] | undefined) ?? [];
  const rowTags = (row.tags as string[] | undefined) ?? [];
  for (const tag of [...defaultTags, ...rowTags]) {
    if (!mergedTags.includes(tag)) mergedTags.push(tag);
  }

  const merged: Record<string, unknown> = {
    ...(defaults ?? {}),
    ...row,
  };
  // tags get special union handling
  delete merged.tags;
  // depends_on is resolved separately into depends_on_id
  delete merged.depends_on;
  // sort_order is computed upstream
  delete merged.sort_order;

  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith("_")) continue;
    if (value === undefined || value === null) continue;
    flags[snakeToKebab(key)] = String(value);
  }

  if (mergedTags.length > 0) {
    flags["tags"] = mergedTags.join(",");
  }

  // Apply the effective epic_id if the row/defaults didn't set one.
  if (!flags["epic-id"] && effectiveEpicId) {
    flags["epic-id"] = effectiveEpicId;
  }

  // Lane resolution: row > defaults > top-level.
  if (!flags["lane"] && topLevelLane) {
    flags["lane"] = topLevelLane;
  }

  flags["sort-order"] = String(sortOrder);
  flags["batch-id"] = batchId;
  if (dependsOnId) flags["depends-on-id"] = dependsOnId;

  return flags;
}

function buildEpicFlags(
  epic: z.infer<typeof EpicInputSchema>,
  defaults: Record<string, unknown> | undefined,
  batchId: string,
): Record<string, string> {
  const flags: Record<string, string> = { title: epic.title };
  if (epic.description != null) flags["description"] = epic.description;
  if (epic.initiative_id != null) flags["initiative-id"] = epic.initiative_id;
  if (epic.sort_order !== undefined) flags["sort-order"] = String(epic.sort_order);
  flags["batch-id"] = batchId;
  if (defaults?.actor_id) flags["actor-id"] = String(defaults.actor_id);
  if (defaults?.actor_type) flags["actor-type"] = String(defaults.actor_type);
  if (defaults?.source) flags["source"] = String(defaults.source);
  return flags;
}

export function runBatch(payload: unknown, rootDir: string): BatchIngestResult {
  const parsed = BatchPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Batch payload validation failed:\n${formatZodError(parsed.error)}\n\nNo files written. Fix the errors and re-run.`,
    );
  }
  const {
    defaults,
    epic,
    epic_id: topLevelEpicId,
    tasks,
    sort_start,
    sort_step,
    lane: topLevelLane,
  } = parsed.data;

  const batchId = uuid();

  // Build epic envelope (if present).
  let epicBuilt:
    | { envelope: Record<string, unknown>; entityId: string; slug: string; sortOrder: number }
    | null = null;
  if (epic) {
    const epicFlags = buildEpicFlags(epic, defaults, batchId);
    const { envelope, entityId, slug } = buildEpicEnvelope(epicFlags);
    epicBuilt = { envelope, entityId, slug, sortOrder: epic.sort_order ?? 0 };
  }

  // Determine effective epic_id for task rows when the row doesn't set one.
  const effectiveEpicId =
    epicBuilt?.entityId ?? topLevelEpicId ?? (defaults?.epic_id as string | undefined) ?? null;

  // ── sort_order resolution ─────────────────────────────────────────────────
  const start = sort_start ?? (defaults?.sort_order as number | undefined) ?? 0;
  const step = sort_step ?? 10;
  const sortOrders: number[] = tasks.map((row, idx) =>
    row.sort_order !== undefined ? row.sort_order : start + idx * step,
  );

  // ── depends_on resolution (pass 1: generate UUIDs per-row, resolve refs) ──
  // We need each task's UUID before we know anything else, because rows may
  // depend_on later rows via index. Generate all UUIDs up-front.
  const taskUuids: string[] = tasks.map(() => uuid());
  const dependencyErrors: string[] = [];
  const dependsOnIds: (string | null)[] = tasks.map(() => null);

  tasks.forEach((row, idx) => {
    const dep = row.depends_on;
    if (dep === undefined) return;
    if (typeof dep === "number") {
      if (!Number.isInteger(dep) || dep < 0 || dep >= tasks.length) {
        dependencyErrors.push(
          `  tasks[${idx}].depends_on: index ${dep} out of range (valid: 0..${tasks.length - 1})`,
        );
        return;
      }
      if (dep === idx) {
        dependencyErrors.push(`  tasks[${idx}].depends_on: self reference (index ${dep})`);
        return;
      }
      if (dep > idx) {
        dependencyErrors.push(
          `  tasks[${idx}].depends_on: forward reference (index ${dep} appears after task ${idx}); re-order tasks so predecessors come first`,
        );
        return;
      }
      dependsOnIds[idx] = taskUuids[dep];
    } else if (typeof dep === "string") {
      if (!UUID_RE.test(dep)) {
        dependencyErrors.push(
          `  tasks[${idx}].depends_on: "${dep}" is neither a UUID nor a batch index`,
        );
        return;
      }
      if (dep === taskUuids[idx]) {
        dependencyErrors.push(`  tasks[${idx}].depends_on: self reference`);
        return;
      }
      dependsOnIds[idx] = dep;
    }
  });

  // Cycle check within this batch: walk each task's ancestry up to depth 50.
  // External UUIDs (referring to pre-existing tasks) are trusted as leaves.
  if (dependencyErrors.length === 0) {
    const indexByUuid = new Map<string, number>();
    taskUuids.forEach((id, i) => indexByUuid.set(id, i));
    tasks.forEach((_, startIdx) => {
      const visited = new Set<number>();
      let cursor: number | undefined = startIdx;
      let depth = 0;
      while (cursor !== undefined) {
        if (depth++ > 50) {
          dependencyErrors.push(`  tasks[${startIdx}].depends_on: chain too deep (>50)`);
          break;
        }
        if (visited.has(cursor)) {
          dependencyErrors.push(`  tasks[${startIdx}].depends_on: cycle detected`);
          break;
        }
        visited.add(cursor);
        const nextId = dependsOnIds[cursor];
        if (!nextId) break;
        cursor = indexByUuid.get(nextId);
      }
    });
  }

  if (dependencyErrors.length > 0) {
    throw new Error(
      `Batch validation failed (${dependencyErrors.length} error${dependencyErrors.length === 1 ? "" : "s"}):\n${dependencyErrors.join("\n")}\n\nNo files written. Fix the errors and re-run.`,
    );
  }

  // Build all task envelopes. We pre-assigned UUIDs, so `buildTaskEnvelope`'s
  // internal `uuid()` would create a fresh one — we override afterwards.
  const buildErrors: string[] = [];
  const tasksBuilt: {
    envelope: Record<string, unknown>;
    entityId: string;
    slug: string;
    sortOrder: number;
    lane: string | null;
    dependsOnId: string | null;
  }[] = [];
  tasks.forEach((row, idx) => {
    try {
      const flags = buildTaskFlags(
        row,
        defaults,
        effectiveEpicId,
        sortOrders[idx],
        batchId,
        dependsOnIds[idx],
        topLevelLane,
      );
      const built = buildTaskEnvelope(flags);
      // Rewrite the auto-generated UUID to the one we pre-assigned so
      // depends_on_id references resolve correctly.
      const preAssigned = taskUuids[idx];
      const payload = built.envelope.payload as Record<string, unknown>;
      payload.work_item_id = preAssigned;
      tasksBuilt.push({
        envelope: built.envelope,
        entityId: preAssigned,
        slug: built.slug,
        sortOrder: sortOrders[idx],
        lane: (payload.lane as string | undefined) ?? null,
        dependsOnId: dependsOnIds[idx],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      buildErrors.push(`  tasks[${idx}]: ${msg}`);
    }
  });

  // Validate all envelopes (epic + tasks) in memory before any write.
  const validateErrors: string[] = [];
  if (epicBuilt) {
    try {
      validateEnvelope(epicBuilt.envelope);
    } catch (err) {
      validateErrors.push(`  epic: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  tasksBuilt.forEach((built, idx) => {
    try {
      validateEnvelope(built.envelope);
    } catch (err) {
      validateErrors.push(`  tasks[${idx}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const allErrors = [...buildErrors, ...validateErrors];
  if (allErrors.length > 0) {
    throw new Error(
      `Batch validation failed (${allErrors.length} error${allErrors.length === 1 ? "" : "s"}):\n${allErrors.join("\n")}\n\nNo files written. Fix the errors and re-run.`,
    );
  }

  // All valid — write to inbox in order.
  let epicResult: BatchEpicResult | null = null;
  if (epicBuilt) {
    const base = writeToInbox(epicBuilt.envelope, "epic", epicBuilt.entityId, epicBuilt.slug, rootDir);
    epicResult = { ...base, sort_order: epicBuilt.sortOrder };
  }
  const taskResults: BatchTaskResult[] = tasksBuilt.map((built) => {
    const base = writeToInbox(built.envelope, "task", built.entityId, built.slug, rootDir);
    return {
      ...base,
      sort_order: built.sortOrder,
      lane: built.lane,
      depends_on_id: built.dependsOnId,
    };
  });

  const distinctLanes = Array.from(
    new Set(taskResults.map((t) => t.lane).filter((l): l is string => !!l)),
  ).sort();

  return {
    batch_id: batchId,
    epic: epicResult,
    tasks: taskResults,
    summary: {
      epics: epicResult ? 1 : 0,
      tasks: taskResults.length,
      lanes: distinctLanes,
    },
  };
}

// ── Run (orchestrates parse → build → validate → write) ─────────────────────

export function readJsonFromStdin(): string {
  // Synchronous read from fd 0. Returns the raw string; caller parses.
  return fs.readFileSync(0, "utf-8");
}

// Overloads: narrow the return shape based on the subcommand when callers
// pass a literal so existing test sites keep strong typing on IngestResult.
export function run(argv: ["batch", ...string[]], rootDir: string): BatchIngestResult;
export function run(argv: string[], rootDir: string): IngestResult | BatchIngestResult;
export function run(argv: string[], rootDir: string): IngestResult | BatchIngestResult {
  const { subcommand, positional, flags } = parseArgs(argv);

  switch (subcommand) {
    case "task": {
      const { envelope, entityId, slug } = buildTaskEnvelope(flags);
      return writeToInbox(envelope, "task", entityId, slug, rootDir);
    }
    case "epic": {
      const { envelope, entityId, slug } = buildEpicEnvelope(flags);
      return writeToInbox(envelope, "epic", entityId, slug, rootDir);
    }
    case "comment": {
      const { envelope, entityId, slug } = buildCommentEnvelope(flags);
      return writeToInbox(envelope, "comment", entityId, slug, rootDir);
    }
    case "batch": {
      const raw = positional[0];
      const jsonString = !raw || raw === "-" ? readJsonFromStdin() : raw;
      if (!jsonString.trim()) {
        throw new Error("batch subcommand requires a JSON payload (positional arg or stdin)");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(jsonString);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid JSON payload: ${msg}`);
      }
      return runBatch(payload, rootDir);
    }
    case "delete-task": {
      const { envelope, entityId, slug } = buildWorkItemDeleteEnvelope(flags);
      return writeToInbox(envelope, "task", entityId, slug, rootDir);
    }
    case "delete-epic": {
      const { envelope, entityId, slug } = buildEpicDeleteEnvelope(flags);
      return writeToInbox(envelope, "epic", entityId, slug, rootDir);
    }
    case "delete-comment": {
      const { envelope, entityId, slug } = buildCommentDeleteEnvelope(flags);
      return writeToInbox(envelope, "comment", entityId, slug, rootDir);
    }
    case "delete-initiative": {
      const { envelope, entityId, slug } = buildInitiativeDeleteEnvelope(flags);
      return writeToInbox(envelope, "initiative", entityId, slug, rootDir);
    }
    case "set-awaiting": {
      const { envelope, entityId, slug } = buildSetAwaitingEnvelope(flags);
      return writeToInbox(envelope, "task", entityId, slug, rootDir);
    }
    default:
      throw new Error(`Unknown subcommand: "${subcommand}". Use "task", "epic", "comment", "batch", "delete-task", "delete-epic", "delete-comment", "delete-initiative", or "set-awaiting".`);
  }
}
