import { Router, Request, Response } from "express";
import { listActivityEvents } from "@server/db/repositories/activity-events.js";

const router = Router();

// GET / — list activity events, optional filters
router.get("/", (req: Request, res: Response) => {
  try {
    const { entity_type, entity_id, event_type, limit } = req.query;

    const events = listActivityEvents({
      entityType: entity_type as string | undefined,
      entityId: entity_id as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : 50,
    });

    // Filter by event_type in-memory since the repo filter doesn't support it directly
    if (event_type) {
      const filtered = events.filter((e) => e.event_type === event_type);
      res.json(filtered);
      return;
    }

    res.json(events);
  } catch (err) {
    console.error("[activity] GET / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
