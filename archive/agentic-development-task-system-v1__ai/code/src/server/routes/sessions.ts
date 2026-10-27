import { Router, type Request, type Response } from "express";
import { v4 as uuid } from "uuid";
import {
  insertSession,
  getSessionById,
  listSessions,
  updateSession,
} from "../db/repositories/sessions.js";
import { getWorkItemById, updateWorkItem } from "../db/repositories/work-items.js";
import { getSubItems } from "../db/repositories/work-items.js";
import { getEpicById } from "../db/repositories/epics.js";
import { insertActivityEvent } from "../db/repositories/activity-events.js";
import * as tmux from "../terminal/tmux.js";

type IdParams = { id: string };
const router = Router();

// GET / — list sessions
router.get("/", (req: Request, res: Response) => {
  try {
    const { state, workItemId } = req.query;
    const sessions = listSessions({
      state: state as string | undefined,
      primaryWorkItemId: workItemId as string | undefined,
    });

    // Reconcile: if DB says running/starting but tmux doesn't have the
    // session, flip to disconnected so dead sessions don't appear live.
    const liveTmuxNames = new Set(tmux.listSessions().map((s) => s.name));
    for (const s of sessions) {
      const needsCheck =
        (s.state === "running" || s.state === "starting") &&
        s.tmux_session_name !== null;
      if (needsCheck && !liveTmuxNames.has(s.tmux_session_name as string)) {
        updateSession(s.id, { state: "disconnected" });
        s.state = "disconnected";
      }
    }

    res.json(sessions);
  } catch (err) {
    console.error("[sessions] GET / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id — get session by ID (includes work item + epic data)
router.get("/:id", (req: Request<IdParams>, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Enrich with work item and epic data
    const workItem = session.primary_work_item_id
      ? getWorkItemById(session.primary_work_item_id)
      : null;
    const epic =
      workItem && (workItem as any).epic_id
        ? getEpicById((workItem as any).epic_id)
        : null;

    res.json({ ...session, workItem, epic });
  } catch (err) {
    console.error("[sessions] GET /:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / — create a new session for a work item (launches claude + pastes ticket)
router.post("/", async (req: Request, res: Response) => {
  try {
    const { workItemId } = req.body;
    if (!workItemId) {
      res.status(400).json({ error: "workItemId is required" });
      return;
    }

    const workItem = getWorkItemById(workItemId);
    if (!workItem) {
      res.status(404).json({ error: "Work item not found" });
      return;
    }

    const sessionId = uuid();
    const shortId = workItemId.slice(0, 8);
    const tmuxName = `task-${shortId}`;

    // If a tmux session with this name already exists, kill it
    if (tmux.sessionExists(tmuxName)) {
      tmux.killSession(tmuxName);
    }

    // Create tmux session
    tmux.createSession(tmuxName);

    // Insert DB row
    const now = new Date().toISOString();
    insertSession({
      id: sessionId,
      title: (workItem as any).title,
      state: "running",
      tmux_session_name: tmuxName,
      cwd: process.cwd(),
      branch_name: (workItem as any).branch_name ?? null,
      primary_work_item_id: workItemId,
      started_at: now,
      last_seen_at: now,
      exited_at: null,
      exit_code: null,
      metadata_json: null,
      claude_session_id: null,
    });

    // Set work_item.active_session_id
    updateWorkItem(workItemId, { active_session_id: sessionId });

    // Launch claude inside tmux
    tmux.sendKeys(tmuxName, "claude", true);

    // Wait for claude to start, then apply tab adornments and paste the ticket
    setTimeout(() => {
      try {
        applySessionAdornments(tmuxName, workItem);
        const prompt = assembleTicketPrompt(workItem);
        tmux.sendKeys(tmuxName, prompt, false);
      } catch (err) {
        console.error("[sessions] Failed to paste ticket prompt:", err);
      }
    }, 2000);

    const session = getSessionById(sessionId);
    res.status(201).json(session);
  } catch (err) {
    console.error("[sessions] POST / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/resume — resume a session with its stored Claude session ID
router.post("/:id/resume", (req: Request<IdParams>, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (!session.claude_session_id) {
      res.status(400).json({ error: "No Claude session ID stored — cannot resume" });
      return;
    }

    const tmuxName = session.tmux_session_name;
    if (!tmuxName) {
      res.status(400).json({ error: "No tmux session name" });
      return;
    }

    // Recreate tmux session if dead
    if (!tmux.sessionExists(tmuxName)) {
      tmux.createSession(tmuxName, session.cwd ?? undefined);
    }

    // Resume claude
    tmux.sendKeys(tmuxName, `claude --resume ${session.claude_session_id}`, true);

    // Re-apply tab color and name once Claude is up — slash commands are
    // tab-level and don't survive --resume on their own.
    if (session.primary_work_item_id) {
      const workItem = getWorkItemById(session.primary_work_item_id);
      if (workItem) {
        setTimeout(() => {
          try {
            applySessionAdornments(tmuxName, workItem);
          } catch (err) {
            console.error("[sessions] Failed to re-apply adornments on resume:", err);
          }
        }, 2000);
      }
    }

    // Update state
    updateSession(req.params.id, {
      state: "running",
      last_seen_at: new Date().toISOString(),
    });

    res.json(getSessionById(req.params.id));
  } catch (err) {
    console.error("[sessions] POST /:id/resume error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id — close/archive a session
router.delete("/:id", (req: Request<IdParams>, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Kill tmux session if it exists
    if (session.tmux_session_name && tmux.sessionExists(session.tmux_session_name)) {
      tmux.killSession(session.tmux_session_name);
    }

    // Update state
    updateSession(req.params.id, {
      state: "archived",
      exited_at: new Date().toISOString(),
    });

    // Clear work_item.active_session_id
    if (session.primary_work_item_id) {
      updateWorkItem(session.primary_work_item_id, { active_session_id: null });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[sessions] DELETE /:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/paste — paste literal text into the tmux session without pressing Enter
router.post("/:id/paste", (req: Request<IdParams>, res: Response) => {
  try {
    const session = getSessionById(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const { text } = req.body ?? {};
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    if (session.state !== "running") {
      res.status(400).json({ error: `Session is not running (state: ${session.state})` });
      return;
    }

    if (!session.tmux_session_name) {
      res.status(400).json({ error: "Session has no tmux process" });
      return;
    }

    tmux.sendKeys(session.tmux_session_name, text, false);

    insertActivityEvent({
      id: uuid(),
      event_type: "session.text_pasted",
      entity_type: "session",
      entity_id: session.id,
      source_type: "ui",
      source_ref: null,
      actor_type: "user",
      actor_id: null,
      occurred_at: new Date().toISOString(),
      payload_json: JSON.stringify({ char_count: text.length }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[sessions] POST /:id/paste error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const SUPPORTED_COLORS = new Set([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);
const DEFAULT_COLOR = "blue";
const RENAME_MAX = 60;

function applySessionAdornments(
  tmuxName: string,
  workItem: Record<string, any>,
): void {
  const epic = workItem.epic_id ? getEpicById(workItem.epic_id) : null;
  const epicColor = (epic as any)?.color;
  const color = SUPPORTED_COLORS.has(epicColor) ? epicColor : DEFAULT_COLOR;
  tmux.sendKeys(tmuxName, `/color ${color}`, true);

  const title = String(workItem.title ?? "").trim();
  if (title) {
    tmux.sendKeys(tmuxName, `/rename ${title.slice(0, RENAME_MAX)}`, true);
  }
}

function assembleTicketPrompt(workItem: Record<string, any>): string {
  const parts: string[] = [];
  parts.push(`Implement: ${workItem.title}`);

  if (workItem.body) {
    parts.push(`\n## Description\n${workItem.body}`);
  }

  if (workItem.acceptance_criteria) {
    parts.push(`\n## Acceptance Criteria\n${workItem.acceptance_criteria}`);
  }

  // Context section
  const context: string[] = [];
  if (workItem.epic_id) {
    const epic = getEpicById(workItem.epic_id);
    if (epic) context.push(`- Epic: ${(epic as any).title}`);
  }
  if (workItem.kind) context.push(`- Kind: ${workItem.kind}`);
  if (workItem.status) context.push(`- Status: ${workItem.status}`);
  if (context.length > 0) {
    parts.push(`\n## Context\n${context.join("\n")}`);
  }

  // Subtasks
  try {
    const subtasks = getSubItems(workItem.id);
    if (subtasks.length > 0) {
      const lines = subtasks.map(
        (s: any) => `- [ ] ${s.title}`,
      );
      parts.push(`\n## Subtasks\n${lines.join("\n")}`);
    }
  } catch {
    // If subtasks fail, skip them
  }

  return parts.join("\n");
}

export default router;
