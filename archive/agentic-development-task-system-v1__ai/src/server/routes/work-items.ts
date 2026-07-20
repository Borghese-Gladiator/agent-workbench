import { Router, type Request, type Response } from "express";
import { v4 as uuid } from "uuid";
import {
  listWorkItems, getWorkItemById, insertWorkItem,
  updateWorkItem, updateWorkItemStatus, reorderWorkItems, getSubItems,
} from "@server/db/repositories/work-items.js";
import { getTagsForWorkItem, insertTags, getAllUniqueTags, replaceTagsForWorkItem } from "@server/db/repositories/work-item-tags.js";
import { getReviewsForWorkItem } from "@server/db/repositories/reviews.js";
import { getArtifactsForWorkItem } from "@server/db/repositories/artifacts.js";
import { getEpicById } from "@server/db/repositories/epics.js";
import { insertComment, listCommentsForWorkItem } from "@server/db/repositories/comments.js";
import { insertActivityEvent } from "@server/db/repositories/activity-events.js";
import { validateTransition, InvalidTransitionError } from "@server/domain/work-items.js";
import { renderAdversarialReviewPrompt } from "@server/domain/review-prompts.js";
import { getDb } from "@server/db/connection.js";
import { WORK_ITEM_STATUSES, WORK_ITEM_KINDS, ADVERSARIAL_REVIEW_BOT_ID } from "@shared/constants.js";

type IdParams = { id: string };
const router = Router();

// GET /tags
router.get("/tags", (_req: Request, res: Response) => {
  try {
    res.json(getAllUniqueTags());
  } catch (err) {
    console.error("[work-items] GET /tags error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /
router.get("/", (req: Request, res: Response) => {
  try {
    const { status, kind, epic_id, assigned_agent_id, tag, parent_id, lane, batch_id } = req.query;
    const items = listWorkItems({
      status: status as string | undefined,
      kind: kind as string | undefined,
      epicId: epic_id as string | undefined,
      assignedAgentId: assigned_agent_id as string | undefined,
      tag: tag as string | undefined,
      parentId: parent_id === "null" ? null : parent_id as string | undefined,
      lane: lane as string | undefined,
      batchId: batch_id as string | undefined,
    });
    res.json(items);
  } catch (err) {
    console.error("[work-items] GET / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /
router.post("/", (req: Request, res: Response) => {
  try {
    const { kind, title, body, status, epic_id, parent_id, assigned_agent_id, branch_name, acceptance_criteria, tags, slug, category } = req.body;

    if (!title) { res.status(400).json({ error: "title is required" }); return; }
    if (!kind || !WORK_ITEM_KINDS.includes(kind)) { res.status(400).json({ error: `kind must be one of: ${WORK_ITEM_KINDS.join(", ")}` }); return; }

    const itemStatus = status || "triage";
    if (!WORK_ITEM_STATUSES.includes(itemStatus)) { res.status(400).json({ error: `Invalid status: ${itemStatus}` }); return; }

    const now = new Date().toISOString();
    const id = uuid();

    insertWorkItem({
      id, epic_id: epic_id || null, parent_id: parent_id || null,
      slug: slug || "", kind, title, body: body || "", status: itemStatus,
      category: category || "work",
      awaiting_input: 0, active_session_id: null,
      assigned_agent_id: assigned_agent_id || null, reviewer_agent_id: null,
      branch_name: branch_name || null, acceptance_criteria: acceptance_criteria || null,
      result_summary: null, sort_order: 0,
      lane: null, batch_id: null, depends_on_id: null,
      created_by: "user",
      created_at: now, updated_at: now, completed_at: null, archived_at: null,
    });

    if (tags && Array.isArray(tags) && tags.length > 0) {
      insertTags(id, tags);
    }

    insertActivityEvent({
      id: uuid(), event_type: "work_item.created", entity_type: "work_item", entity_id: id,
      source_type: "ui", source_ref: null, actor_type: "user", actor_id: null,
      occurred_at: now, payload_json: JSON.stringify({ kind, title, status: itemStatus }),
    });

    res.status(201).json(getWorkItemById(id));
  } catch (err) {
    console.error("[work-items] POST / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /reorder
router.put("/reorder", (req: Request, res: Response) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "items array is required" }); return; }
    reorderWorkItems(items);
    res.json({ success: true });
  } catch (err) {
    console.error("[work-items] PUT /reorder error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id
router.get("/:id", (req: Request<IdParams>, res: Response) => {
  try {
    const item = getWorkItemById(req.params.id);
    if (!item) { res.status(404).json({ error: "Work item not found" }); return; }

    const tags = getTagsForWorkItem(req.params.id);
    const reviews = getReviewsForWorkItem(req.params.id);
    const subItems = getSubItems(req.params.id);
    const artifacts = getArtifactsForWorkItem(req.params.id);
    const comments = listCommentsForWorkItem(req.params.id);
    const epic = item.epic_id ? getEpicById(item.epic_id) : null;
    const parent = item.parent_id ? getWorkItemById(item.parent_id) : null;
    res.json({ ...item, tags, reviews, subItems, artifacts, comments, epic, parent });
  } catch (err) {
    console.error("[work-items] GET /:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id
const PATCH_ALLOWED_FIELDS = new Set([
  "title", "body", "status", "epic_id", "parent_id",
  "assigned_agent_id", "reviewer_agent_id", "branch_name",
  "acceptance_criteria", "result_summary", "sort_order",
  "category", "awaiting_input",
  "lane", "depends_on_id",
]);

router.patch("/:id", (req: Request<IdParams>, res: Response) => {
  try {
    const item = getWorkItemById(req.params.id);
    if (!item) { res.status(404).json({ error: "Work item not found" }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if ("batch_id" in body) {
      res.status(400).json({ error: "batch_id is immutable" });
      return;
    }
    const updates: Record<string, unknown> = {};
    let tagsUpdate: string[] | null = null;
    for (const key of Object.keys(body)) {
      if (key === "tags") {
        if (!Array.isArray(body[key])) {
          res.status(400).json({ error: "tags must be an array of strings" });
          return;
        }
        tagsUpdate = (body[key] as unknown[]).map((t) => String(t));
        continue;
      }
      if (!PATCH_ALLOWED_FIELDS.has(key)) {
        res.status(400).json({ error: `Unknown field: ${key}` });
        return;
      }
      updates[key] = body[key];
    }

    if (Object.keys(updates).length > 0) updateWorkItem(req.params.id, updates);
    if (tagsUpdate !== null) replaceTagsForWorkItem(req.params.id, tagsUpdate);
    const updated = getWorkItemById(req.params.id);
    const tags = getTagsForWorkItem(req.params.id);
    res.json({ ...updated, tags });
  } catch (err) {
    console.error("[work-items] PATCH /:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/transition
router.post("/:id/transition", (req: Request<IdParams>, res: Response) => {
  try {
    const id = req.params.id;
    const { status, reason } = req.body;
    if (!status) { res.status(400).json({ error: "status is required" }); return; }

    const item = getWorkItemById(id);
    if (!item) { res.status(404).json({ error: "Work item not found" }); return; }

    const previousStatus = item.status;
    try {
      validateTransition(previousStatus, status);
    } catch (err) {
      if (err instanceof InvalidTransitionError) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }

    const now = new Date().toISOString();
    const shouldCreateReviewComment = status === "in_review" && previousStatus !== "in_review";

    const applyTransition = getDb().transaction(() => {
      updateWorkItemStatus(id, status);
      insertActivityEvent({
        id: uuid(), event_type: "work_item.status_changed", entity_type: "work_item", entity_id: id,
        source_type: "ui", source_ref: null, actor_type: "user", actor_id: null,
        occurred_at: now, payload_json: JSON.stringify({ previous_status: previousStatus, new_status: status, reason: reason || null }),
      });

      if (shouldCreateReviewComment) {
        const body = renderAdversarialReviewPrompt({
          id: item.id,
          title: item.title,
          body: item.body,
          acceptance_criteria: item.acceptance_criteria,
          branch_name: item.branch_name,
        });
        const commentId = uuid();
        insertComment({
          id: commentId,
          work_item_id: id,
          body,
          author_type: "system",
          author_id: ADVERSARIAL_REVIEW_BOT_ID,
          created_at: now,
          updated_at: now,
          edited_at: null,
        });
        insertActivityEvent({
          id: uuid(),
          event_type: "comment.created",
          entity_type: "work_item",
          entity_id: id,
          source_type: "system",
          source_ref: null,
          actor_type: "system",
          actor_id: ADVERSARIAL_REVIEW_BOT_ID,
          occurred_at: now,
          payload_json: JSON.stringify({ comment_id: commentId, reason: "adversarial_review_on_in_review" }),
        });
      }
    });
    applyTransition();

    res.json(getWorkItemById(id));
  } catch (err) {
    console.error("[work-items] POST /:id/transition error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
