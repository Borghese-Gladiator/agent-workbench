import { describe, expect, it } from 'vitest';
import { planQueueSpec, type QueueSpec } from './queue-spec.js';

const spec = (tasks: QueueSpec['tasks']): QueueSpec => ({ projectId: 'p1', tasks });
const t = (key: string, over: Partial<QueueSpec['tasks'][number]> = {}) => ({
  key,
  title: key,
  request: 'r',
  ...over,
});

describe('planQueueSpec', () => {
  it('orders a fan-in DAG dependencies-first', () => {
    const order = planQueueSpec(
      spec([t('fix'), t('test'), t('release', { dependsOn: ['fix', 'test'] })]),
    );
    // release must come after both of its predecessors.
    expect(order.indexOf('release')).toBeGreaterThan(order.indexOf('fix'));
    expect(order.indexOf('release')).toBeGreaterThan(order.indexOf('test'));
    expect(order).toHaveLength(3);
  });

  it('accepts a single-string dependsOn', () => {
    const order = planQueueSpec(spec([t('a'), t('b', { dependsOn: 'a' })]));
    expect(order).toEqual(['a', 'b']);
  });

  it('rejects an unknown dependsOn key', () => {
    expect(() => planQueueSpec(spec([t('b', { dependsOn: 'ghost' })]))).toThrow(/unknown key/);
  });

  it('rejects a duplicate key', () => {
    expect(() => planQueueSpec(spec([t('a'), t('a')]))).toThrow(/duplicate task key/);
  });

  it('rejects a self-dependency', () => {
    expect(() => planQueueSpec(spec([t('a', { dependsOn: 'a' })]))).toThrow(/cannot depend on/);
  });

  it('rejects a cycle', () => {
    expect(() =>
      planQueueSpec(spec([t('a', { dependsOn: 'b' }), t('b', { dependsOn: 'a' })])),
    ).toThrow(/cycle/);
  });

  it('requires projectId and a non-empty task list', () => {
    expect(() => planQueueSpec({ projectId: '', tasks: [t('a')] })).toThrow(/projectId/);
    expect(() => planQueueSpec(spec([]))).toThrow(/non-empty/);
  });

  it('requires title and request on every task', () => {
    expect(() => planQueueSpec(spec([{ key: 'a', title: '', request: 'r' }]))).toThrow(
      /needs a title/,
    );
  });
});
