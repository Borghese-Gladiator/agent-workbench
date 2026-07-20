import { Router, type Request, type Response } from "express";
import { v4 as uuid } from "uuid";
import { listInitiatives, getInitiativeById, insertInitiative, updateInitiative } from "@server/db/repositories/initiatives.js";

type IdParams = { id: string };
const router = Router();

router.get("/", (_req: Request, res: Response) => {
  try {
    res.json(listInitiatives());
  } catch (err) {
    console.error("[initiatives] GET / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", (req: Request, res: Response) => {
  try {
    const { name, description, slug } = req.body;
    if (!name) { res.status(400).json({ error: "name is required" }); return; }

    const now = new Date().toISOString();
    const id = uuid();
    insertInitiative({ id, slug: slug || "", name, description: description || null, status: "active", sort_order: 0, created_at: now, updated_at: now });
    res.status(201).json(getInitiativeById(id));
  } catch (err) {
    console.error("[initiatives] POST / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", (req: Request<IdParams>, res: Response) => {
  try {
    const init = getInitiativeById(req.params.id);
    if (!init) { res.status(404).json({ error: "Initiative not found" }); return; }
    res.json(init);
  } catch (err) {
    console.error("[initiatives] GET /:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/:id", (req: Request<IdParams>, res: Response) => {
  try {
    const init = getInitiativeById(req.params.id);
    if (!init) { res.status(404).json({ error: "Initiative not found" }); return; }
    updateInitiative(req.params.id, req.body);
    res.json(getInitiativeById(req.params.id));
  } catch (err) {
    console.error("[initiatives] PATCH /:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
