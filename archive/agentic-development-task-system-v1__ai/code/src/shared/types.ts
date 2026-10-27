// === Hierarchy types ===
export type InitiativeStatus = "active" | "completed" | "archived";
export type EpicStatus = "open" | "in_progress" | "done" | "archived";
export type EpicColor = "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";
export type WorkItemKind = "task" | "bug";
export type WorkItemStatus =
  | "triage" | "ready" | "in_progress"
  | "in_review" | "done" | "canceled";
export type WorkItemCategory = "work" | "personal";

// === Other enums ===
export type AgentKind = "planner" | "executor" | "reviewer" | "adversarial_reviewer" | "other";
export type ReviewType = "adversarial" | "standard" | "human";
export type ReviewOutcome = "approved" | "changes_requested" | "blocked";
export type ArtifactType = "file" | "diff" | "note" | "log" | "json" | "other";
export type SessionState = "starting" | "running" | "exited" | "disconnected" | "archived";
export type SessionRole = "primary" | "secondary" | "review" | "exploration" | "other";
export type IngestStatus = "processed" | "rejected";

export type EntityType = "initiative" | "epic" | "work_item" | "agent" | "session" | "review" | "artifact" | "system";
export type SourceType = "ingest" | "ui" | "system" | "hook" | "session" | "terminal";
export type ActorType = "user" | "agent" | "system";

// === Domain objects ===

export type Initiative = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: InitiativeStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type Epic = {
  id: string;
  initiativeId: string | null;
  slug: string;
  title: string;
  description: string | null;
  status: EpicStatus;
  color: EpicColor;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkItem = {
  id: string;
  epicId: string | null;
  parentId: string | null;
  slug: string;
  kind: WorkItemKind;
  title: string;
  body: string;
  status: WorkItemStatus;
  category: WorkItemCategory;
  awaitingInput: boolean;
  activeSessionId: string | null;
  assignedAgentId: string | null;
  reviewerAgentId: string | null;
  branchName: string | null;
  acceptanceCriteria: string | null;
  resultSummary: string | null;
  sortOrder: number;
  lane: string | null;
  batchId: string | null;
  dependsOnId: string | null;
  readyToStart: boolean;
  blockedByTitle: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
};

export type WorkItemTag = {
  workItemId: string;
  tag: string;
};

export type Agent = {
  id: string;
  name: string;
  kind: AgentKind;
  description: string | null;
  defaultInstructions: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Review = {
  id: string;
  workItemId: string;
  reviewerAgentId: string | null;
  reviewType: ReviewType;
  outcome: ReviewOutcome;
  summary: string | null;
  detailsJson: string | null;
  createdAt: string;
};

export type Artifact = {
  id: string;
  workItemId: string | null;
  epicId: string | null;
  sessionId: string | null;
  artifactType: ArtifactType;
  title: string | null;
  path: string | null;
  mimeType: string | null;
  metadataJson: string | null;
  createdAt: string;
};

export type TerminalSession = {
  id: string;
  title: string;
  state: SessionState;
  tmuxSessionName: string | null;
  cwd: string | null;
  branchName: string | null;
  primaryWorkItemId: string | null;
  startedAt: string;
  lastSeenAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  metadataJson: string | null;
  claudeSessionId: string | null;
  workItemTitle?: string | null;
};

export type TaskSessionLink = {
  id: string;
  workItemId: string;
  sessionId: string;
  role: SessionRole;
  createdAt: string;
};

export type ActivityEvent = {
  id: string;
  eventType: string;
  entityType: EntityType;
  entityId: string | null;
  sourceType: SourceType;
  sourceRef: string | null;
  actorType: ActorType;
  actorId: string | null;
  occurredAt: string;
  payloadJson: string;
};

export type Comment = {
  id: string;
  workItemId: string;
  body: string;
  authorType: ActorType;
  authorId: string | null;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
};

export type IngestFile = {
  id: string;
  filePath: string;
  fileName: string;
  sha256: string;
  eventType: string | null;
  ingestStatus: IngestStatus;
  rejectionReason: string | null;
  processedAt: string;
};
