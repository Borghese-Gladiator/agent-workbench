import { describe, expect, it } from 'vitest';
import type { FleetTaskRow } from '@awb/database';
import { formatAge, formatAttempt, renderTable, renderMarkdown } from './fleet.js';

function row(overrides: Partial<FleetTaskRow> = {}): FleetTaskRow {
  return {
    taskId: 'abcd1234-0000-0000-0000-000000000000',
    repositoryId: 'repo-1',
    repositoryName: 'games',
    promptLine: 'Implement President',
    phase: 'implement',
    condition: 'running',
    deliveryState: 'not-started',
    size: 'M',
    attempt: 1,
    bouncedFrom: null,
    lastOutcome: null,
    activity: 'writing engine tests',
    activityType: 'tool',
    activityAgeSec: 125,
    openFindings: 0,
    topFinding: null,
    pr: null,
    parentTaskId: null,
    updatedAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatAge', () => {
  it('renders seconds/minutes/hours/days and a dash for null', () => {
    expect(formatAge(null)).toBe('—');
    expect(formatAge(45)).toBe('45s');
    expect(formatAge(125)).toBe('2m');
    expect(formatAge(7200)).toBe('2h');
    expect(formatAge(172800)).toBe('2d');
  });
});

describe('formatAttempt', () => {
  it('is #N on a clean pass and #N ↩phase after a bounce', () => {
    expect(formatAttempt(row({ attempt: 1, bouncedFrom: null }))).toBe('#1');
    expect(formatAttempt(row({ attempt: 3, bouncedFrom: 'verify' }))).toBe('#3 ↩verify');
  });
});

describe('renderMarkdown', () => {
  it('emits a header, separator, and one row per task with the bounce + activity signal', () => {
    const md = renderMarkdown([
      row({ taskId: 'president-xxxx', attempt: 3, bouncedFrom: 'verify', openFindings: 1, activityAgeSec: 120 }),
    ]);
    const lines = md.split('\n');
    expect(lines[0]).toContain('| TASK | REPO | PHASE |');
    expect(lines[1]).toContain('| --- |');
    expect(lines[2]).toContain('#3 ↩verify');
    expect(lines[2]).toContain('writing engine tests (2m)');
    expect(lines[2]).toContain('1 open');
  });

  it('escapes pipe characters in cell values', () => {
    const md = renderMarkdown([row({ activity: 'a|b' })]);
    expect(md).toContain('a\\|b');
  });
});

describe('renderTable', () => {
  it('says so when there are no tasks', () => {
    expect(renderTable([])).toBe('No tasks.');
  });

  it('aligns columns and shows the PR cell', () => {
    const table = renderTable([row({ pr: { number: 42, url: 'u', isDraft: true, state: 'open' } })]);
    expect(table).toContain('TASK');
    expect(table).toContain('#42 draft');
  });
});
