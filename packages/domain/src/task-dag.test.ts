import { describe, expect, it } from 'vitest';
import { validateTaskDag, TaskDagValidationError, type TaskDagSpec } from './task-dag.js';

function spec(nodes: TaskDagSpec['nodes']): TaskDagSpec {
  return { repositoryId: 'repo-1', nodes };
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
