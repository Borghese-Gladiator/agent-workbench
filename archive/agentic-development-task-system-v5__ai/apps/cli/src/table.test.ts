import { describe, expect, it } from 'vitest';
import { formatColumns } from './table.js';

describe('formatColumns', () => {
  it('never leaves trailing whitespace on a line', () => {
    for (const line of formatColumns(['A', 'BBBB'], [['x', 'y'], ['zzz', '']])) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('sizes each column to its header or its widest cell', () => {
    const lines = formatColumns(
      ['PHASE', 'DURATION'],
      [
        ['plan #1', '9.0s'],
        ['implement #1', '3m25s'],
      ],
    );
    expect(lines[0]).toBe('PHASE         DURATION');
    expect(lines[1]).toBe('plan #1       9.0s');
    expect(lines[2]).toBe('implement #1  3m25s');
  });

  it('returns the header alone when there are no rows', () => {
    expect(formatColumns(['A', 'B'], [])).toEqual(['A  B']);
  });

  it('tolerates a short row rather than throwing on a missing cell', () => {
    const lines = formatColumns(['A', 'B'], [['only']]);
    expect(lines[1]).toBe('only');
  });
});
