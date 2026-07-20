import { describe, expect, it } from 'vitest';
import { splitCommandString } from './verification-runner.js';

describe('splitCommandString', () => {
  it('splits a simple space-separated command', () => {
    expect(splitCommandString('pnpm test')).toEqual(['pnpm', 'test']);
  });

  it('keeps a double-quoted argument intact', () => {
    expect(splitCommandString('node -e "process.exit(1)"')).toEqual(['node', '-e', 'process.exit(1)']);
  });

  it('keeps a single-quoted argument intact', () => {
    expect(splitCommandString("sh -c 'echo hello world'")).toEqual(['sh', '-c', 'echo hello world']);
  });

  it('handles a single-token command with no arguments', () => {
    expect(splitCommandString('pytest')).toEqual(['pytest']);
  });

  it('handles multiple quoted segments in one command', () => {
    expect(splitCommandString('cmd "first arg" "second arg"')).toEqual(['cmd', 'first arg', 'second arg']);
  });
});
