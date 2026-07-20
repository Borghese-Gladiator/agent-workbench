import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Per-project memory: ONE append-only markdown file per project, holding the
 * durable decisions (architectural / implementation / naming / convention + the
 * "why") distilled from each task at closeout. Unlike artifacts (task-scoped,
 * one file each), this is a single growing log keyed by projectId.
 *
 * It is the cross-task continuity the workbench otherwise lacks: closeout
 * appends here, and a new task's discovery/planning reads it back so it starts
 * knowing what the project already decided instead of re-deriving it.
 */
export class ProjectMemoryStore {
  constructor(private readonly rootDir: string) {}

  private abs(projectId: string): string {
    return join(this.rootDir, `${projectId}.md`);
  }

  /** Read the whole memory file, or '' if this project has none yet. */
  read(projectId: string): string {
    const abs = this.abs(projectId);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  }

  /**
   * Append one entry. Seeds a file header on first write, then appends the entry
   * separated by a blank line. The entry is stored verbatim — the caller owns its
   * shape (heading, date, decision bullets).
   */
  append(projectId: string, entry: string): void {
    const abs = this.abs(projectId);
    mkdirSync(dirname(abs), { recursive: true });
    const trimmed = entry.trim();
    if (!existsSync(abs)) {
      const header =
        `# Project memory\n\n` +
        `Durable decisions distilled from each completed task — architecture,\n` +
        `implementation, naming, and convention choices and the reasoning behind\n` +
        `them. Read this before discovery/planning; append to it at closeout.\n`;
      writeFileSync(abs, `${header}\n${trimmed}\n`, 'utf8');
      return;
    }
    const existing = readFileSync(abs, 'utf8').replace(/\s+$/, '');
    writeFileSync(abs, `${existing}\n\n${trimmed}\n`, 'utf8');
  }
}
