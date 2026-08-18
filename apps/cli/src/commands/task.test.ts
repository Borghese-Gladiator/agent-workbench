import { describe, expect, it } from 'vitest';
import { deriveTaskTitle } from './task.js';

describe('deriveTaskTitle', () => {
  it.each([
    ['first sentence up to a period', 'Add a compression seam. Then wire it in.', 'Add a compression seam'],
    ['stops at a question mark', 'Why is the socket leaking? It reopens on click.', 'Why is the socket leaking'],
    ['collapses interior whitespace and newlines', 'Fix   the\n\n  gate\tlogic.', 'Fix the gate logic'],
    ['strips a lone trailing terminator on a single-sentence prompt', 'Ship the report!', 'Ship the report'],
    ['keeps a prompt with no sentence terminator whole', 'add cross-repo token report', 'add cross-repo token report'],
  ])('%s', (_desc, prompt, expected) => {
    expect(deriveTaskTitle(prompt)).toBe(expected);
  });

  it('truncates a long first sentence to maxLength with an ellipsis', () => {
    const prompt = 'a'.repeat(200);
    const title = deriveTaskTitle(prompt, 20);
    expect(title).toHaveLength(20);
    expect(title.endsWith('…')).toBe(true);
  });

  it('returns a placeholder for an empty or whitespace-only prompt', () => {
    expect(deriveTaskTitle('')).toBe('(no prompt)');
    expect(deriveTaskTitle('   \n\t ')).toBe('(no prompt)');
  });

  it('returns a placeholder when the prompt is only sentence punctuation', () => {
    expect(deriveTaskTitle('...')).toBe('(no prompt)');
  });
});
