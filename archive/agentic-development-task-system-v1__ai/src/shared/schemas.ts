import { z } from "zod";

// Common ingest envelope
export const IngestEnvelopeSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.string().min(1),
  occurred_at: z.string().datetime(),
  source: z.string().min(1),
  actor: z.object({
    type: z.enum(["user", "agent", "system"]),
    id: z.string().min(1),
  }),
  payload: z.record(z.unknown()),
});

// epic.created payload
export const EpicCreatedPayloadSchema = z.object({
  epic_id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  initiative_id: z.string().nullable().optional(),
  sort_order: z.number().int().optional(),
  batch_id: z.string().uuid().nullable().optional(),
});

// work_item.created payload
export const WorkItemCreatedPayloadSchema = z.object({
  work_item_id: z.string().uuid(),
  kind: z.enum(["task", "bug"]),
  title: z.string().min(1),
  body: z.string().default(""),
  status: z.enum(["triage", "ready", "in_progress", "in_review", "done", "canceled"]).default("triage"),
  epic_id: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  assigned_agent_id: z.string().nullable().optional(),
  branch_name: z.string().nullable().optional(),
  acceptance_criteria: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  sort_order: z.number().int().optional(),
  lane: z.string().max(40).nullable().optional(),
  batch_id: z.string().uuid().nullable().optional(),
  depends_on_id: z.string().uuid().nullable().optional(),
});

// work_item.status_changed payload
export const WorkItemStatusChangedPayloadSchema = z.object({
  work_item_id: z.string().uuid(),
  from_status: z.string().min(1),
  to_status: z.enum(["triage", "ready", "in_progress", "in_review", "done", "canceled"]),
  reason: z.string().nullable().optional(),
});

// work_item.assigned payload
export const WorkItemAssignedPayloadSchema = z.object({
  work_item_id: z.string().uuid(),
  agent_id: z.string().min(1),
  role: z.enum(["executor", "reviewer"]).default("executor"),
});

// work_item.session_linked payload
export const WorkItemSessionLinkedPayloadSchema = z.object({
  work_item_id: z.string().uuid(),
  session_id: z.string().uuid(),
  role: z.enum(["primary", "secondary", "review", "exploration", "other"]),
});

// work_item.updated payload
export const WorkItemUpdatedPayloadSchema = z.object({
  work_item_id: z.string().uuid(),
  updates: z.record(z.unknown()),
});

// session.declared payload
export const SessionDeclaredPayloadSchema = z.object({
  session_id: z.string().uuid(),
  title: z.string().min(1),
  cwd: z.string().nullable().optional(),
  branch_name: z.string().nullable().optional(),
  tmux_session_name: z.string().nullable().optional(),
  primary_work_item_id: z.string().nullable().optional(),
});

// review.requested payload
export const ReviewRequestedPayloadSchema = z.object({
  work_item_id: z.string().uuid(),
  reviewer_agent_id: z.string().nullable().optional(),
  review_type: z.enum(["adversarial", "standard", "human"]),
});

// review.completed payload
export const ReviewCompletedPayloadSchema = z.object({
  review_id: z.string().uuid(),
  work_item_id: z.string().uuid(),
  review_type: z.enum(["adversarial", "standard", "human"]),
  reviewer_agent_id: z.string().nullable().optional(),
  outcome: z.enum(["approved", "changes_requested", "blocked"]),
  summary: z.string().nullable().optional(),
  details: z.record(z.unknown()).nullable().optional(),
});

// artifact.attached payload
export const ArtifactAttachedPayloadSchema = z.object({
  artifact_id: z.string().uuid(),
  work_item_id: z.string().nullable().optional(),
  epic_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  artifact_type: z.enum(["file", "diff", "note", "log", "json", "other"]),
  title: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  mime_type: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

// comment.created payload
export const CommentCreatedPayloadSchema = z.object({
  comment_id: z.string().uuid(),
  work_item_id: z.string().uuid(),
  body: z.string().min(1),
});

// comment.updated payload
export const CommentUpdatedPayloadSchema = z.object({
  comment_id: z.string().uuid(),
  body: z.string().min(1),
});

// comment.deleted payload
export const CommentDeletedPayloadSchema = z.object({
  comment_id: z.string().uuid(),
});

// work_item.deleted payload
export const WorkItemDeletedPayloadSchema = z.object({
  work_item_id: z.string().uuid(),
});

// epic.deleted payload
export const EpicDeletedPayloadSchema = z.object({
  epic_id: z.string().uuid(),
});

// initiative.deleted payload
export const InitiativeDeletedPayloadSchema = z.object({
  initiative_id: z.string().uuid(),
});

// Map event_type to its payload schema
export const PayloadSchemaMap: Record<string, z.ZodType> = {
  "epic.created": EpicCreatedPayloadSchema,
  "work_item.created": WorkItemCreatedPayloadSchema,
  "work_item.updated": WorkItemUpdatedPayloadSchema,
  "work_item.status_changed": WorkItemStatusChangedPayloadSchema,
  "work_item.assigned": WorkItemAssignedPayloadSchema,
  "work_item.session_linked": WorkItemSessionLinkedPayloadSchema,
  "session.declared": SessionDeclaredPayloadSchema,
  "review.requested": ReviewRequestedPayloadSchema,
  "review.completed": ReviewCompletedPayloadSchema,
  "artifact.attached": ArtifactAttachedPayloadSchema,
  "comment.created": CommentCreatedPayloadSchema,
  "comment.updated": CommentUpdatedPayloadSchema,
  "comment.deleted": CommentDeletedPayloadSchema,
  "work_item.deleted": WorkItemDeletedPayloadSchema,
  "epic.deleted": EpicDeletedPayloadSchema,
  "initiative.deleted": InitiativeDeletedPayloadSchema,
};
