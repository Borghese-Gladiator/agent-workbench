import { Router, type Request, type Response } from "express";
import { v4 as uuid } from "uuid";
import { listEpicsWithCounts, getEpicById, insertEpic, updateEpic } from "@server/db/repositories/epics.js";
import { listWorkItems } from "@server/db/repositories/work-items.js";
import { insertActivityEvent } from "@server/db/repositories/activity-events.js";

type IdParams = { id: string };
const router = Router();

router.get("/", (req: Request, res: Response) => {
  try {
    const { initiative_id, status } = req.query;
    res.json(listEpicsWithCounts({
      initiativeId: initiative_id as string | undefined,
      status: status as string | undefined,
    }));
  } catch (err) {
    console.error("[epics] GET / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", (req: Request, res: Response) => {
  try {
    const { title, description, initiative_id, slug, color } = req.body;
    if (!title) { res.status(400).json({ error: "title is required" }); return; }

    const now = new Date().toISOString();
    const id = uuid();
    insertEpic({ id, initiative_id: initiative_id || null, slug: slug || "", title, description: description || null, status: "open", color: color || "blue", sort_order: 0, batch_id: null, created_at: now, updated_at: now });

    insertActivityEvent({
      id: uuid(), event_type: "epic.created", entity_type: "epic", entity_id: id,
      source_type: "ui", source_ref: null, actor_type: "user", actor_id: null,
      occurred_at: now, payload_json: JSON.stringify({ title }),
    });

    res.status(201).json(getEpicById(id));
  } catch (err) {
    console.error("[epics] POST / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", (req: Request<IdParams>, res: Response) => {
  try {
    const epic = getEpicById(req.params.id);
    if (!epic) { res.status(404).json({ error: "Epic not found" }); return; }

    const workItems = listWorkItems({ epicId: req.params.id, parentId: null });
    res.json({ ...epic, workItems });
  } catch (err) {
    console.error("[epics] GET /:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/:id", (req: Request<IdParams>, res: Response) => {
  try {
    const epic = getEpicById(req.params.id);
    if (!epic) { res.status(404).json({ error: "Epic not found" }); return; }
    updateEpic(req.params.id, req.body);
    res.json(getEpicById(req.params.id));
  } catch (err) {
    console.error("[epics] PATCH /:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
