import { v4 as uuidv4 } from 'uuid';
import type { z } from 'zod';
import type { IngestEnvelopeSchema } from '@shared/schemas.js';

import { insertEpic, getEpicById, deleteEpic } from '@server/db/repositories/epics.js';
import { getInitiativeById, deleteInitiative } from '@server/db/repositories/initiatives.js';
import { insertWorkItem, updateWorkItem, updateWorkItemStatus, getWorkItemById, deleteWorkItem } from '@server/db/repositories/work-items.js';
import { upsertAgent } from '@server/db/repositories/agents.js';
import { insertActivityEvent } from '@server/db/repositories/activity-events.js';
import { insertIngestFile, findBySha256 } from '@server/db/repositories/ingest-files.js';
import { insertSession } from '@server/db/repositories/sessions.js';
import { insertLink } from '@server/db/repositories/task-session-links.js';
import { insertTags } from '@server/db/repositories/work-item-tags.js';
import { insertReview } from '@server/db/repositories/reviews.js';
import { insertArtifact } from '@server/db/repositories/artifacts.js';
import {
  insertComment,
  getCommentById,
  updateCommentBody,
  deleteComment,
} from '@server/db/repositories/comments.js';

type Envelope = z.infer<typeof IngestEnvelopeSchema>;

export type ProcessResult =
  | { success: true; event_type: string; entity_id: string | null }
  | { success: false; event_type: string; error: string };

function recordActivity(
  envelope: Envelope,
  entityType: string,
  entityId: string | null,
  payloadOverride?: Record<string, unknown>,
): void {
  insertActivityEvent({
    id: uuidv4(),
    event_type: envelope.event_type,
    entity_type: entityType,
    entity_id: entityId,
    source_type: 'ingest',
    source_ref: envelope.source,
    actor_type: envelope.actor.type,
    actor_id: envelope.actor.id,
    occurred_at: envelope.occurred_at,
    payload_json: JSON.stringify(payloadOverride ?? envelope.payload),
  });
}

function recordIngestFile(filePath: string, fileName: string, sha256: string, eventType: string): void {
  insertIngestFile({
    id: uuidv4(),
    file_path: filePath,
    file_name: fileName,
    sha256,
    event_type: eventType,
    ingest_status: 'processed',
    rejection_reason: null,
    processed_at: new Date().toISOString(),
  });
}

// ─── Handlers ────────────────────────────────────────────────────────────────

function handleEpicCreated(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as {
    epic_id: string; title: string; description?: string | null; initiative_id?: string | null;
    sort_order?: number; batch_id?: string | null;
  };
  const now = new Date().toISOString();

  insertEpic({
    id: p.epic_id, initiative_id: p.initiative_id ?? null, slug: '', title: p.title,
    description: p.description ?? null, status: 'open', color: 'blue',
    sort_order: p.sort_order ?? 0, batch_id: p.batch_id ?? null,
    created_at: now, updated_at: now,
  });

  recordActivity(envelope, 'epic', p.epic_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.epic_id };
}

function handleWorkItemCreated(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as {
    work_item_id: string; kind: string; title: string; body?: string; status?: string;
    epic_id?: string | null; parent_id?: string | null; assigned_agent_id?: string | null;
    branch_name?: string | null; acceptance_criteria?: string | null; tags?: string[];
    sort_order?: number; lane?: string | null; batch_id?: string | null;
    depends_on_id?: string | null;
  };
  const now = new Date().toISOString();

  insertWorkItem({
    id: p.work_item_id, epic_id: p.epic_id ?? null, parent_id: p.parent_id ?? null,
    slug: '', kind: p.kind, title: p.title, body: p.body || '', status: p.status || 'triage',
    category: 'work', awaiting_input: 0, active_session_id: null,
    assigned_agent_id: p.assigned_agent_id ?? null,
    reviewer_agent_id: null, branch_name: p.branch_name ?? null,
    acceptance_criteria: p.acceptance_criteria ?? null, result_summary: null,
    sort_order: p.sort_order ?? 0,
    lane: p.lane ?? null, batch_id: p.batch_id ?? null,
    depends_on_id: p.depends_on_id ?? null,
    created_by: envelope.actor.id, created_at: now, updated_at: now,
    completed_at: null, archived_at: null,
  });

  if (p.tags && p.tags.length > 0) insertTags(p.work_item_id, p.tags);

  recordActivity(envelope, 'work_item', p.work_item_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.work_item_id };
}

function handleWorkItemStatusChanged(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as { work_item_id: string; from_status: string; to_status: string; reason?: string | null };
  updateWorkItemStatus(p.work_item_id, p.to_status);
  recordActivity(envelope, 'work_item', p.work_item_id, { from_status: p.from_status, to_status: p.to_status, reason: p.reason ?? null });
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.work_item_id };
}

function handleWorkItemAssigned(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as { work_item_id: string; agent_id: string; role: 'executor' | 'reviewer' };
  if (p.role === 'reviewer') {
    updateWorkItem(p.work_item_id, { reviewer_agent_id: p.agent_id });
  } else {
    updateWorkItem(p.work_item_id, { assigned_agent_id: p.agent_id });
  }
  recordActivity(envelope, 'work_item', p.work_item_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.work_item_id };
}

function handleWorkItemSessionLinked(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as { work_item_id: string; session_id: string; role: string };
  const now = new Date().toISOString();
  insertLink({ id: uuidv4(), work_item_id: p.work_item_id, session_id: p.session_id, role: p.role, created_at: now });
  recordActivity(envelope, 'work_item', p.work_item_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.work_item_id };
}

function handleWorkItemUpdated(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const { work_item_id, updates } = payload as { work_item_id: string; updates: Record<string, unknown> };
  if (updates && Object.keys(updates).length > 0) updateWorkItem(work_item_id, updates);
  recordActivity(envelope, 'work_item', work_item_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: work_item_id };
}

function handleSessionDeclared(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as {
    session_id: string; title: string; cwd?: string | null; branch_name?: string | null;
    tmux_session_name?: string | null; primary_work_item_id?: string | null;
  };
  const now = new Date().toISOString();

  insertSession({
    id: p.session_id, title: p.title, state: 'running', tmux_session_name: p.tmux_session_name ?? null,
    cwd: p.cwd ?? null, branch_name: p.branch_name ?? null,
    primary_work_item_id: p.primary_work_item_id ?? null, started_at: now,
    last_seen_at: now, exited_at: null, exit_code: null, metadata_json: null,
    claude_session_id: null,
  });

  if (p.primary_work_item_id) {
    insertLink({ id: uuidv4(), work_item_id: p.primary_work_item_id, session_id: p.session_id, role: 'primary', created_at: now });
  }

  recordActivity(envelope, 'session', p.session_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.session_id };
}

function handleReviewRequested(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as { work_item_id: string; reviewer_agent_id?: string | null; review_type: string };
  const updates: Record<string, unknown> = { status: 'in_review' };
  if (p.reviewer_agent_id) updates.reviewer_agent_id = p.reviewer_agent_id;
  updateWorkItem(p.work_item_id, updates);
  recordActivity(envelope, 'work_item', p.work_item_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.work_item_id };
}

function handleReviewCompleted(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as {
    review_id: string; work_item_id: string; review_type: string;
    reviewer_agent_id?: string | null; outcome: 'approved' | 'changes_requested' | 'blocked';
    summary?: string | null; details?: Record<string, unknown> | null;
  };
  const now = new Date().toISOString();

  insertReview({
    id: p.review_id, work_item_id: p.work_item_id, reviewer_agent_id: p.reviewer_agent_id ?? null,
    review_type: p.review_type, outcome: p.outcome, summary: p.summary ?? null,
    details_json: p.details ? JSON.stringify(p.details) : null, created_at: now,
  });

  const outcomeToStatus: Record<string, string> = { approved: 'done', changes_requested: 'ready', blocked: 'triage' };
  updateWorkItemStatus(p.work_item_id, outcomeToStatus[p.outcome]);

  recordActivity(envelope, 'review', p.review_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.review_id };
}

function handleArtifactAttached(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as {
    artifact_id: string; work_item_id?: string | null; epic_id?: string | null;
    session_id?: string | null; artifact_type: string; title?: string | null;
    path?: string | null; mime_type?: string | null; metadata?: Record<string, unknown> | null;
  };
  const now = new Date().toISOString();

  insertArtifact({
    id: p.artifact_id, work_item_id: p.work_item_id ?? null, epic_id: p.epic_id ?? null,
    session_id: p.session_id ?? null, artifact_type: p.artifact_type, title: p.title ?? null,
    path: p.path ?? null, mime_type: p.mime_type ?? null,
    metadata_json: p.metadata ? JSON.stringify(p.metadata) : null, created_at: now,
  });

  recordActivity(envelope, 'artifact', p.artifact_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.artifact_id };
}

function handleCommentCreated(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as { comment_id: string; work_item_id: string; body: string };
  const now = new Date().toISOString();

  insertComment({
    id: p.comment_id,
    work_item_id: p.work_item_id,
    body: p.body,
    author_type: envelope.actor.type,
    author_id: envelope.actor.id,
    created_at: now,
    updated_at: now,
    edited_at: null,
  });

  recordActivity(envelope, 'work_item', p.work_item_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.comment_id };
}

function handleCommentUpdated(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as { comment_id: string; body: string };
  const existing = getCommentById(p.comment_id);
  if (!existing) {
    return { success: false, event_type: envelope.event_type, error: `Comment not found: ${p.comment_id}` };
  }

  const now = new Date().toISOString();
  updateCommentBody(p.comment_id, p.body, now);

  recordActivity(envelope, 'work_item', existing.work_item_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.comment_id };
}

function handleCommentDeleted(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as { comment_id: string };
  const existing = getCommentById(p.comment_id);
  if (!existing) {
    return { success: false, event_type: envelope.event_type, error: `Comment not found: ${p.comment_id}` };
  }

  deleteComment(p.comment_id);

  recordActivity(envelope, 'work_item', existing.work_item_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.comment_id };
}

function handleWorkItemDeleted(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as { work_item_id: string };
  const existing = getWorkItemById(p.work_item_id);
  if (!existing) {
    return { success: false, event_type: envelope.event_type, error: `Work item not found: ${p.work_item_id}` };
  }

  try {
    deleteWorkItem(p.work_item_id);
  } catch (err) {
    return {
      success: false,
      event_type: envelope.event_type,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  recordActivity(envelope, 'work_item', p.work_item_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.work_item_id };
}

function handleEpicDeleted(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as { epic_id: string };
  const existing = getEpicById(p.epic_id);
  if (!existing) {
    return { success: false, event_type: envelope.event_type, error: `Epic not found: ${p.epic_id}` };
  }

  try {
    deleteEpic(p.epic_id);
  } catch (err) {
    return {
      success: false,
      event_type: envelope.event_type,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  recordActivity(envelope, 'epic', p.epic_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.epic_id };
}

function handleInitiativeDeleted(envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string): ProcessResult {
  const p = payload as { initiative_id: string };
  const existing = getInitiativeById(p.initiative_id);
  if (!existing) {
    return { success: false, event_type: envelope.event_type, error: `Initiative not found: ${p.initiative_id}` };
  }

  try {
    deleteInitiative(p.initiative_id);
  } catch (err) {
    return {
      success: false,
      event_type: envelope.event_type,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  recordActivity(envelope, 'initiative', p.initiative_id);
  recordIngestFile(filePath, fileName, sha256, envelope.event_type);
  return { success: true, event_type: envelope.event_type, entity_id: p.initiative_id };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const handlers: Record<string, (envelope: Envelope, payload: Record<string, unknown>, filePath: string, fileName: string, sha256: string) => ProcessResult> = {
  'epic.created': handleEpicCreated,
  'work_item.created': handleWorkItemCreated,
  'work_item.status_changed': handleWorkItemStatusChanged,
  'work_item.assigned': handleWorkItemAssigned,
  'work_item.session_linked': handleWorkItemSessionLinked,
  'work_item.updated': handleWorkItemUpdated,
  'session.declared': handleSessionDeclared,
  'review.requested': handleReviewRequested,
  'review.completed': handleReviewCompleted,
  'artifact.attached': handleArtifactAttached,
  'comment.created': handleCommentCreated,
  'comment.updated': handleCommentUpdated,
  'comment.deleted': handleCommentDeleted,
  'work_item.deleted': handleWorkItemDeleted,
  'epic.deleted': handleEpicDeleted,
  'initiative.deleted': handleInitiativeDeleted,
};

export function processIngestEvent(
  envelope: Envelope, payload: unknown, filePath: string, fileName: string, sha256: string,
): ProcessResult {
  try {
    const existing = findBySha256(sha256);
    if (existing.length > 0) {
      return { success: false, event_type: envelope.event_type, error: `Duplicate file detected (sha256: ${sha256})` };
    }

    const handler = handlers[envelope.event_type];
    if (!handler) {
      return { success: false, event_type: envelope.event_type, error: `No handler for event_type: "${envelope.event_type}"` };
    }

    return handler(envelope, payload as Record<string, unknown>, filePath, fileName, sha256);
  } catch (err) {
    return { success: false, event_type: envelope.event_type, error: err instanceof Error ? err.message : String(err) };
  }
}
