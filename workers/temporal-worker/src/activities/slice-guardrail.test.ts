import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveSliceDiffCap,
  sliceDiffExceedsCap,
  DEFAULT_SLICE_DIFF_LINE_CAP,
  DEFAULT_SLICE_DIFF_FILE_CAP,
} from './slice-guardrail.js';

const ENV_KEYS = ['AWB_SLICE_DIFF_CAP', 'AWB_SLICE_DIFF_LINE_CAP', 'AWB_SLICE_DIFF_FILE_CAP'];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('resolveSliceDiffCap (TASK-56)', () => {
  it('is disabled on the mock path (realPath=false)', () => {
    expect(resolveSliceDiffCap(false).enabled).toBe(false);
  });

  it('is enabled on a real-agent path with the default caps', () => {
    const cap = resolveSliceDiffCap(true);
    expect(cap.enabled).toBe(true);
    expect(cap.lineCap).toBe(DEFAULT_SLICE_DIFF_LINE_CAP);
    expect(cap.fileCap).toBe(DEFAULT_SLICE_DIFF_FILE_CAP);
  });

  it('can be disabled on the real path via AWB_SLICE_DIFF_CAP=0', () => {
    process.env.AWB_SLICE_DIFF_CAP = '0';
    expect(resolveSliceDiffCap(true).enabled).toBe(false);
  });

  it('honors env overrides for the bounds', () => {
    process.env.AWB_SLICE_DIFF_LINE_CAP = '50';
    process.env.AWB_SLICE_DIFF_FILE_CAP = '3';
    const cap = resolveSliceDiffCap(true);
    expect(cap.lineCap).toBe(50);
    expect(cap.fileCap).toBe(3);
  });
});

describe('sliceDiffExceedsCap (TASK-56)', () => {
  const cap = { enabled: true, lineCap: 400, fileCap: 20 };

  it('trips when lines exceed the cap', () => {
    expect(sliceDiffExceedsCap(cap, { changedLines: 401, changedFiles: 1 })).toBe(true);
  });

  it('trips when files exceed the cap', () => {
    expect(sliceDiffExceedsCap(cap, { changedLines: 1, changedFiles: 21 })).toBe(true);
  });

  it('does not trip under both bounds', () => {
    expect(sliceDiffExceedsCap(cap, { changedLines: 400, changedFiles: 20 })).toBe(false);
  });

  it('a disabled cap never trips', () => {
    expect(sliceDiffExceedsCap({ enabled: false, lineCap: 1, fileCap: 1 }, { changedLines: 9999, changedFiles: 9999 })).toBe(
      false,
    );
  });
});
