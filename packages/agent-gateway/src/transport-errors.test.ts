import { describe, expect, it } from 'vitest';
import { isResumableTransportError } from './transport-errors.js';

describe('isResumableTransportError (TASK-32)', () => {
  it.each([
    ['API Error: Connection closed mid-response'],
    ['Connection closed'],
    ['read ECONNRESET'],
    ['socket hang up'],
    ['Error: Premature close'],
    ['stream closed unexpectedly'],
  ])('classifies transport drop %j as resumable', (message) => {
    expect(isResumableTransportError(new Error(message))).toBe(true);
    expect(isResumableTransportError(message)).toBe(true);
  });

  it.each([
    ['builder-session-incomplete'],
    ['no accepted plan available'],
    ['Invalid contract objective'],
    [''],
  ])('does NOT classify logic/engineering failure %j as resumable', (message) => {
    expect(isResumableTransportError(new Error(message))).toBe(false);
  });

  it('returns false for non-error, non-string values', () => {
    expect(isResumableTransportError(undefined)).toBe(false);
    expect(isResumableTransportError(null)).toBe(false);
    expect(isResumableTransportError({ message: 'Connection closed' })).toBe(false);
  });
});
