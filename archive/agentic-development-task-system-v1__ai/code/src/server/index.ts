import express from "express";
import { createServer } from "node:http";
import cors from "cors";
import { runMigrations } from "./db/migrate.js";
import { closeDb } from "./db/connection.js";
import { startWatcher, stopWatcher, getWatcherStatus } from "./ingest/index.js";
import { setupTerminalWebSocket } from "./terminal/ws-relay.js";
import initiativeRoutes from "./routes/initiatives.js";
import epicRoutes from "./routes/epics.js";
import workItemRoutes from "./routes/work-items.js";
import agentRoutes from "./routes/agents.js";
import activityRoutes from "./routes/activity.js";
import sessionRoutes from "./routes/sessions.js";
import { workItemCommentsRouter, commentsRouter } from "./routes/comments.js";

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT ?? 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Run database migrations on startup
console.log("[server] Running database migrations...");
runMigrations();
console.log("[server] Migrations complete.");

// Start the ingest file watcher
const repoPaths = (process.env.WATCH_REPOS ?? process.cwd()).split(",").map((p) => p.trim());
startWatcher(repoPaths);

// Set up WebSocket relay for terminal sessions
setupTerminalWebSocket(httpServer);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Ingest watcher status
app.get("/api/ingest/status", (_req, res) => {
  res.json(getWatcherStatus());
});

// Mount route modules
app.use("/api/initiatives", initiativeRoutes);
app.use("/api/epics", epicRoutes);
app.use("/api/work-items/:id/comments", workItemCommentsRouter);
app.use("/api/work-items", workItemRoutes);
app.use("/api/comments", commentsRouter);
app.use("/api/agents", agentRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/sessions", sessionRoutes);

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[server] Received ${signal}. Shutting down gracefully...`);

  await stopWatcher();
  closeDb();

  httpServer.close(() => {
    console.log("[server] HTTP server closed.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[server] Forced exit after timeout.");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
