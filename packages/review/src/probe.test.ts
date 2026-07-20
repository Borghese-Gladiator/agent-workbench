import { describe, expect, it } from 'vitest';
import { createProbeRequest, type ProbeRequest } from './probe.js';

describe('createProbeRequest', () => {
  it('builds a probe request with only a description', () => {
    const probe = createProbeRequest('run the currency-conversion unit test in isolation');
    expect(probe).toEqual({ description: 'run the currency-conversion unit test in isolation' });
  });

  it('builds a probe request with a description and targetPath', () => {
    const probe = createProbeRequest('check for N+1 queries', 'src/reports/query.ts');
    expect(probe).toEqual({ description: 'check for N+1 queries', targetPath: 'src/reports/query.ts' });
  });

  it('never carries a field that could represent an edit or patch', () => {
    const probe: ProbeRequest = createProbeRequest('inspect only');
    const keys = Object.keys(probe);
    expect(keys.every((k) => k === 'description' || k === 'targetPath')).toBe(true);
  });
});
