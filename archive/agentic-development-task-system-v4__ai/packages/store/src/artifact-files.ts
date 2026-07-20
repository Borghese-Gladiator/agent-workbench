import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Artifact bodies live on disk under a gitignored data/artifacts dir, addressed
 * by task and artifact id. The DB stores only the relative path + byte size.
 */
export class ArtifactFileStore {
  constructor(private readonly rootDir: string) {}

  /** Relative path used as the DB body_path; stable for a given (task, artifact). */
  relPath(taskId: string, artifactId: string): string {
    return join(taskId, `${artifactId}.md`);
  }

  /** Writes the body and returns {relPath, byteSize}. */
  write(taskId: string, artifactId: string, body: string): { relPath: string; byteSize: number } {
    const rel = this.relPath(taskId, artifactId);
    const abs = join(this.rootDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
    return { relPath: rel, byteSize: Buffer.byteLength(body, 'utf8') };
  }

  read(relPath: string): string {
    return readFileSync(join(this.rootDir, relPath), 'utf8');
  }

  /**
   * Copy an external file (e.g. a Playwright video/trace produced inside a task
   * worktree) into durable artifact storage under `<task>/demo-assets/`, so the
   * proof survives worktree cleanup. Returns the stored relative path. The
   * filename is preserved; collisions are de-duped with a numeric suffix.
   */
  copyAsset(taskId: string, srcAbsPath: string): string {
    const name = basename(srcAbsPath);
    const dir = join(taskId, 'demo-assets');
    let rel = join(dir, name);
    // Playwright names every scenario's video `video.webm` (and trace `trace.zip`),
    // so multiple sources collide on one filename. Suffix collisions so every
    // scenario's proof is preserved rather than overwritten.
    let n = 1;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    while (existsSync(join(this.rootDir, rel))) {
      rel = join(dir, `${stem}-${n}${ext}`);
      n += 1;
    }
    const abs = join(this.rootDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    copyFileSync(srcAbsPath, abs);
    return rel;
  }

  /** Filenames of the durable demo-assets copied for a task (empty if none). */
  listAssets(taskId: string): string[] {
    const dir = join(this.rootDir, taskId, 'demo-assets');
    try {
      return readdirSync(dir).sort();
    } catch {
      return [];
    }
  }

  /**
   * Resolve a demo-asset filename to its absolute path for serving, or null if it
   * doesn't exist. `filename` must be a bare name — anything with a path separator
   * or `..` is rejected to prevent traversal out of the task's demo-assets dir.
   */
  assetAbsPath(taskId: string, filename: string): string | null {
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return null;
    }
    const abs = join(this.rootDir, taskId, 'demo-assets', filename);
    return existsSync(abs) ? abs : null;
  }
}
