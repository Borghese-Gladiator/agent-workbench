import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectMemoryStore } from './project-memory-files.js';

let dir: string;
let mem: ProjectMemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-mem-'));
  mem = new ProjectMemoryStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ProjectMemoryStore', () => {
  it('returns empty string for a project with no memory', () => {
    expect(mem.read('prj_unknown')).toBe('');
  });

  it('seeds a header on first append and keeps the entry', () => {
    mem.append('prj_a', '## 2026-06-17 — First task\n- chose X — because Y');
    const out = mem.read('prj_a');
    expect(out).toContain('# Project memory');
    expect(out).toContain('## 2026-06-17 — First task');
    expect(out).toContain('- chose X — because Y');
    // Header appears exactly once.
    expect(out.match(/# Project memory/g)).toHaveLength(1);
  });

  it('appends subsequent entries after the header, in order', () => {
    mem.append('prj_a', '## entry one\n- a');
    mem.append('prj_a', '## entry two\n- b');
    const out = mem.read('prj_a');
    expect(out.match(/# Project memory/g)).toHaveLength(1);
    expect(out.indexOf('## entry one')).toBeLessThan(out.indexOf('## entry two'));
    // Entries are blank-line separated, not jammed together.
    expect(out).toContain('- a\n\n## entry two');
  });

  it('keeps memory isolated per project', () => {
    mem.append('prj_a', '## a-only');
    mem.append('prj_b', '## b-only');
    expect(mem.read('prj_a')).toContain('a-only');
    expect(mem.read('prj_a')).not.toContain('b-only');
    expect(mem.read('prj_b')).toContain('b-only');
  });
});
