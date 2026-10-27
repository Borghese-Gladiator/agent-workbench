import { Router, type Request, type Response } from "express";
import { v4 as uuid } from "uuid";

type IdParams = { id: string };

import {
  listAgents,
  getAgentById,
  insertAgent,
} from "@server/db/repositories/agents.js";

const router = Router();

// GET / — list agents
router.get("/", (_req: Request, res: Response) => {
  try {
    const agents = listAgents();
    res.json(agents);
  } catch (err) {
    console.error("[agents] GET / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / — create agent
router.post("/", (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const agent = {
      id: req.body.id || uuid(),
      name: req.body.name,
      kind: req.body.kind,
      description: req.body.description || null,
      default_instructions: req.body.default_instructions || null,
      is_active: req.body.is_active ?? 1,
      created_at: now,
      updated_at: now,
    };

    if (!agent.name || !agent.kind) {
      res.status(400).json({ error: "name and kind are required" });
      return;
    }

    insertAgent(agent);
    res.status(201).json(agent);
  } catch (err) {
    console.error("[agents] POST / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id — get agent by id
router.get("/:id", (req: Request<IdParams>, res: Response) => {
  try {
    const agent = getAgentById(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(agent);
  } catch (err) {
    console.error("[agents] GET /:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
