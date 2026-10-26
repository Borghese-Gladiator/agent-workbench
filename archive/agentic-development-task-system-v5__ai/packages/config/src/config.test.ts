import { describe, expect, it } from 'vitest';
import { WorkbenchConfigSchema } from './config.js';

describe('WorkbenchConfigSchema planning.disableProgramDesign', () => {
  it('defaults planning.disableProgramDesign to false when absent', () => {
    const parsed = WorkbenchConfigSchema.parse({});
    expect(parsed.planning.disableProgramDesign).toBe(false);
  });

  it('defaults the flag when planning is present but the flag is omitted', () => {
    const parsed = WorkbenchConfigSchema.parse({ planning: {} });
    expect(parsed.planning.disableProgramDesign).toBe(false);
  });

  it('honors an explicit override', () => {
    const parsed = WorkbenchConfigSchema.parse({ planning: { disableProgramDesign: true } });
    expect(parsed.planning.disableProgramDesign).toBe(true);
  });

  it('rejects a non-boolean flag', () => {
    expect(() => WorkbenchConfigSchema.parse({ planning: { disableProgramDesign: 'yes' } })).toThrow();
  });
});
