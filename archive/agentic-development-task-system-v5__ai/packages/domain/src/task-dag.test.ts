import { describe, expect, it } from 'vitest';
import { validateTaskDag, TaskDagValidationError, TaskDagSpecSchema } from './task-dag.js';
import type { z } from 'zod';

type SpecInput = z.input<typeof TaskDagSpecSchema>;

// Parse through the schema so a legacy scalar `dependsOn` is normalized to a typed edge, matching
// how the route validates the request body before calling validateTaskDag.
function spec(nodes: SpecInput['nodes']) {
  return TaskDagSpecSchema.parse({ repositoryId: 'repo-1', nodes });
}

describe('validateTaskDag', () => {
  it('topo-sorts a linear chain parents-first', () => {
    const order = validateTaskDag(
      spec([
        { key: 'c', prompt: 'C', dependsOn: 'b' },
        { key: 'a', prompt: 'A' },
        { key: 'b', prompt: 'B', dependsOn: 'a' },
      ]),
    );
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('allows fan-out (two children sharing one parent)', () => {
    const order = validateTaskDag(
      spec([
        { key: 'a', prompt: 'A' },
        { key: 'b', prompt: 'B', dependsOn: 'a' },
        { key: 'c', prompt: 'C', dependsOn: 'a' },
      ]),
    );
    // a must come before both b and c; b/c order among themselves is unconstrained.
    expect(order[0]).toBe('a');
    expect(new Set(order)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('accepts a diamond via `after` edges (D after B and C, both after A)', () => {
    const order = validateTaskDag(
      spec([
        { key: 'a', prompt: 'A' },
        { key: 'b', prompt: 'B', dependsOn: [{ ref: 'a', mode: 'after' }] },
        { key: 'c', prompt: 'C', dependsOn: [{ ref: 'a', mode: 'after' }] },
        { key: 'd', prompt: 'D', dependsOn: [{ ref: 'b', mode: 'after' }, { ref: 'c', mode: 'after' }] },
      ]),
    );
    // A first, D last; B and C between A and D.
    expect(order[0]).toBe('a');
    expect(order[order.length - 1]).toBe('d');
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('allows one `stack` base plus an `after` predecessor on the same node', () => {
    const order = validateTaskDag(
      spec([
        { key: 'a', prompt: 'A' },
        { key: 'b', prompt: 'B' },
        { key: 'c', prompt: 'C', dependsOn: [{ ref: 'a', mode: 'stack' }, { ref: 'b', mode: 'after' }] },
      ]),
    );
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('rejects two `stack` parents on one node', () => {
    expect(() =>
      validateTaskDag(
        spec([
          { key: 'a', prompt: 'A' },
          { key: 'b', prompt: 'B' },
          { key: 'c', prompt: 'C', dependsOn: [{ ref: 'a', mode: 'stack' }, { ref: 'b', mode: 'stack' }] },
        ]),
      ),
    ).toThrow(/stack.*parents/);
  });

  it('normalizes a legacy scalar dependsOn to a single `stack` edge', () => {
    const order = validateTaskDag(
      spec([
        { key: 'a', prompt: 'A' },
        { key: 'b', prompt: 'B', dependsOn: 'a' },
      ]),
    );
    expect(order).toEqual(['a', 'b']);
  });

  it('rejects a duplicate key', () => {
    expect(() => validateTaskDag(spec([{ key: 'a', prompt: 'A' }, { key: 'a', prompt: 'A2' }]))).toThrow(
      TaskDagValidationError,
    );
  });

  it('rejects a dangling dependsOn', () => {
    expect(() => validateTaskDag(spec([{ key: 'a', prompt: 'A', dependsOn: 'ghost' }]))).toThrow(
      /unknown key "ghost"/,
    );
  });

  it('rejects a self-edge', () => {
    expect(() => validateTaskDag(spec([{ key: 'a', prompt: 'A', dependsOn: 'a' }]))).toThrow(/depends on itself/);
  });

  it('rejects a cycle', () => {
    expect(() =>
      validateTaskDag(
        spec([
          { key: 'a', prompt: 'A', dependsOn: 'b' },
          { key: 'b', prompt: 'B', dependsOn: 'a' },
        ]),
      ),
    ).toThrow(/cycle/);
  });
});
