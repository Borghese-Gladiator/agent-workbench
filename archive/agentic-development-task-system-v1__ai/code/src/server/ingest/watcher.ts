import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  INGEST_DIR,
  INBOX_DIR,
  PROCESSED_DIR,
  REJECTED_DIR,
  ATTACHMENTS_DIR,
} from '@shared/constants.js';
import { validateIngestFile } from './validator.js';
import { processIngestEvent } from './processor.js';
import { insertIngestFile } from '@server/db/repositories/ingest-files.js';
import { v4 as uuidv4 } from 'uuid';

let watcher: FSWatcher | null = null;
let watchedPaths: string[] = [];
let filesProcessed = 0;
let filesRejected = 0;
let startedAt: string | null = null;
const repoByInbox = new Map<string, string>();

// Serialize handler invocations so files written in the same tick are processed
// in the order they're enqueued. chokidar's `add` emit order is filesystem-
// dependent, so we rely on the CLI writing files in the correct order and the
// watcher then draining them one at a time.
let pendingChain: Promise<void> = Promise.resolve();

/**
 * Ensure the required data/ingest subdirectories exist for a repo path.
 */
function ensureDirectories(repoPath: string): void {
  const taskboardBase = path.join(repoPath, INGEST_DIR);
  const dirs = [INBOX_DIR, PROCESSED_DIR, REJECTED_DIR, ATTACHMENTS_DIR];

  for (const dir of dirs) {
    const fullPath = path.join(taskboardBase, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      console.log(`[watcher] Created directory: ${fullPath}`);
    }
  }
}

/**
 * Move a file from one path to another, creating the destination directory if needed.
 */
function moveFile(src: string, destDir: string, fileName: string): string {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Add timestamp prefix to avoid collisions
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destFileName = `${timestamp}__${fileName}`;
  const destPath = path.join(destDir, destFileName);

  fs.renameSync(src, destPath);
  return destPath;
}

/**
 * Wait for a file to be fully written by checking size stability.
 */
function waitForFileReady(filePath: string, timeoutMs = 100): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

/**
 * Handle a newly detected JSON file in the inbox.
 */
async function handleNewFile(filePath: string): Promise<void> {
  const fileName = path.basename(filePath);
  const repoPath = repoByInbox.get(path.dirname(filePath));
  if (!repoPath) {
    console.error(`[watcher] No repo registered for inbox: ${path.dirname(filePath)}`);
    return;
  }

  console.log(`[watcher] New file detected: ${filePath}`);

  // Wait for file write to complete
  await waitForFileReady(filePath);

  // Check if file still exists (may have been moved by another process)
  if (!fs.existsSync(filePath)) {
    console.log(`[watcher] File no longer exists (already processed?): ${filePath}`);
    return;
  }

  // Read file content
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`[watcher] Failed to read file: ${filePath}`, err);
    return;
  }

  // Compute SHA-256 hash
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');

  // Validate
  const result = validateIngestFile(content);

  if (!result.valid) {
    console.log(`[watcher] Validation failed for ${fileName}: ${result.reason}`);

    // Record rejected file in DB
    insertIngestFile({
      id: uuidv4(),
      file_path: filePath,
      file_name: fileName,
      sha256,
      event_type: null,
      ingest_status: 'rejected',
      rejection_reason: result.reason,
      processed_at: new Date().toISOString(),
    });

    // Move to rejected
    const rejectedDir = path.join(repoPath, INGEST_DIR, REJECTED_DIR);
    const destPath = moveFile(filePath, rejectedDir, fileName);
    console.log(`[watcher] Moved to rejected: ${destPath}`);
    filesRejected++;
    return;
  }

  // Process
  const processResult = processIngestEvent(
    result.envelope,
    result.payload,
    filePath,
    fileName,
    sha256,
  );

  if (!processResult.success) {
    console.error(
      `[watcher] Processing failed for ${fileName}: ${processResult.error}`,
    );

    // Record rejected file in DB
    insertIngestFile({
      id: uuidv4(),
      file_path: filePath,
      file_name: fileName,
      sha256,
      event_type: result.envelope.event_type,
      ingest_status: 'rejected',
      rejection_reason: processResult.error,
      processed_at: new Date().toISOString(),
    });

    const rejectedDir = path.join(repoPath, INGEST_DIR, REJECTED_DIR);
    const destPath = moveFile(filePath, rejectedDir, fileName);
    console.log(`[watcher] Moved to rejected: ${destPath}`);
    filesRejected++;
    return;
  }

  // Move to processed
  const processedDir = path.join(repoPath, INGEST_DIR, PROCESSED_DIR);
  const destPath = moveFile(filePath, processedDir, fileName);
  console.log(
    `[watcher] Processed ${result.envelope.event_type} -> ${processResult.entity_id}, moved to: ${destPath}`,
  );
  filesProcessed++;
}

/**
 * Start watching one or more repo paths for new ingest JSON files.
 */
export function startWatcher(repoPaths: string[]): void {
  if (watcher) {
    console.log('[watcher] Watcher already running. Stop it first.');
    return;
  }

  watchedPaths = repoPaths;
  filesProcessed = 0;
  filesRejected = 0;
  startedAt = new Date().toISOString();
  repoByInbox.clear();

  // Ensure directories exist for all repo paths
  for (const repoPath of repoPaths) {
    ensureDirectories(repoPath);
  }

  // Watch inbox directories (not globs — chokidar v4 doesn't detect new files via globs)
  const watchDirs = repoPaths.map((repoPath) => {
    const inbox = path.resolve(repoPath, INGEST_DIR, INBOX_DIR);
    repoByInbox.set(inbox, path.resolve(repoPath));
    return inbox;
  });

  console.log(`[watcher] Starting watcher for ${repoPaths.length} repo(s):`);
  for (const dir of watchDirs) {
    console.log(`[watcher]   ${dir}`);
  }

  watcher = chokidarWatch(watchDirs, {
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  const enqueuedPaths = new Set<string>();
  watcher.on('add', (filePath: string) => {
    // Only process .json files
    if (!filePath.endsWith('.json')) return;
    // Dedupe: chokidar occasionally emits `add` more than once for the same
    // path (especially when awaitWriteFinish's polling overlaps with our
    // rename-to-processed move).
    if (enqueuedPaths.has(filePath)) return;
    enqueuedPaths.add(filePath);
    // Serialize: each new file waits for the previous handler to finish.
    pendingChain = pendingChain.then(async () => {
      try {
        await handleNewFile(filePath);
      } catch (err) {
        console.error(`[watcher] Unexpected error handling ${filePath}:`, err);
      } finally {
        enqueuedPaths.delete(filePath);
      }
    });
  });

  watcher.on('error', (error: unknown) => {
    console.error('[watcher] Watcher error:', error);
  });

  watcher.on('ready', () => {
    console.log('[watcher] Initial scan complete. Watching for new files...');
  });
}

/**
 * Stop the file watcher.
 */
export async function stopWatcher(): Promise<void> {
  if (!watcher) {
    console.log('[watcher] No watcher running.');
    return;
  }

  console.log('[watcher] Stopping watcher...');
  await watcher.close();
  watcher = null;
  repoByInbox.clear();
  console.log('[watcher] Watcher stopped.');
}

/**
 * Wait for all enqueued handler invocations to drain. For tests.
 */
export function drainPending(): Promise<void> {
  return pendingChain;
}

/**
 * Get the current watcher status.
 */
export function getWatcherStatus(): {
  running: boolean;
  watchedPaths: string[];
  filesProcessed: number;
  filesRejected: number;
  startedAt: string | null;
} {
  return {
    running: watcher !== null,
    watchedPaths,
    filesProcessed,
    filesRejected,
    startedAt,
  };
}
