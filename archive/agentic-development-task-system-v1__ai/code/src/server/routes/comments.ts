import { Router, type Request, type Response } from "express";
import { v4 as uuid } from "uuid";
import {
  insertComment,
  listCommentsForWorkItem,
  getCommentById,
  updateCommentBody,
  deleteComment,
} from "@server/db/repositories/comments.js";
import { getWorkItemById } from "@server/db/repositories/work-items.js";
import { insertActivityEvent } from "@server/db/repositories/activity-events.js";

type IdParams = { id: string };
type CommentIdParams = { commentId: string };

// Router mounted at /api/work-items/:id/comments
export const workItemCommentsRouter = Router({ mergeParams: true });

workItemCommentsRouter.get("/", (req: Request<IdParams>, res: Response) => {
  try {
    const workItem = getWorkItemById(req.params.id);
    if (!workItem) { res.status(404).json({ error: "Work item not found" }); return; }

    res.json(listCommentsForWorkItem(req.params.id));
  } catch (err) {
    console.error("[comments] GET / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

workItemCommentsRouter.post("/", (req: Request<IdParams>, res: Response) => {
  try {
    const workItem = getWorkItemById(req.params.id);
    if (!workItem) { res.status(404).json({ error: "Work item not found" }); return; }

    const { body, author_type, author_id } = req.body ?? {};
    const trimmed = typeof body === "string" ? body.trim() : "";
    if (!trimmed) { res.status(400).json({ error: "body is required" }); return; }

    const now = new Date().toISOString();
    const id = uuid();
    const authorType = author_type === "agent" || author_type === "system" ? author_type : "user";

    insertComment({
      id,
      work_item_id: req.params.id,
      body: trimmed,
      author_type: authorType,
      author_id: author_id ?? null,
      created_at: now,
      updated_at: now,
      edited_at: null,
    });

    insertActivityEvent({
      id: uuid(),
      event_type: "comment.created",
      entity_type: "work_item",
      entity_id: req.params.id,
      source_type: "ui",
      source_ref: null,
      actor_type: authorType,
      actor_id: author_id ?? null,
      occurred_at: now,
      payload_json: JSON.stringify({ comment_id: id, work_item_id: req.params.id, body: trimmed }),
    });

    res.status(201).json(getCommentById(id));
  } catch (err) {
    console.error("[comments] POST / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Router mounted at /api/comments
export const commentsRouter = Router();

commentsRouter.patch("/:commentId", (req: Request<CommentIdParams>, res: Response) => {
  try {
    const comment = getCommentById(req.params.commentId);
    if (!comment) { res.status(404).json({ error: "Comment not found" }); return; }

    const { body } = req.body ?? {};
    const trimmed = typeof body === "string" ? body.trim() : "";
    if (!trimmed) { res.status(400).json({ error: "body is required" }); return; }

    const now = new Date().toISOString();
    updateCommentBody(req.params.commentId, trimmed, now);

    insertActivityEvent({
      id: uuid(),
      event_type: "comment.updated",
      entity_type: "work_item",
      entity_id: comment.work_item_id,
      source_type: "ui",
      source_ref: null,
      actor_type: comment.author_type,
      actor_id: comment.author_id,
      occurred_at: now,
      payload_json: JSON.stringify({ comment_id: req.params.commentId, body: trimmed }),
    });

    res.json(getCommentById(req.params.commentId));
  } catch (err) {
    console.error("[comments] PATCH /:commentId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

commentsRouter.delete("/:commentId", (req: Request<CommentIdParams>, res: Response) => {
  try {
    const comment = getCommentById(req.params.commentId);
    if (!comment) { res.status(404).json({ error: "Comment not found" }); return; }

    deleteComment(req.params.commentId);

    const now = new Date().toISOString();
    insertActivityEvent({
      id: uuid(),
      event_type: "comment.deleted",
      entity_type: "work_item",
      entity_id: comment.work_item_id,
      source_type: "ui",
      source_ref: null,
      actor_type: comment.author_type,
      actor_id: comment.author_id,
      occurred_at: now,
      payload_json: JSON.stringify({ comment_id: req.params.commentId }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[comments] DELETE /:commentId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
