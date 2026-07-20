import { describe, expect, it } from 'vitest';
import { extractSymbolsFromSource } from './symbols.js';

describe('extractSymbolsFromSource', () => {
  it('extracts an exported function and class from TypeScript', async () => {
    const source = `
export function greet(name: string): string {
  return 'hi ' + name;
}

export class Greeter {
  greet() {}
}

export interface GreetOptions {
  loud: boolean;
}

export type GreetResult = string;

export const defaultGreeting = 'hello';

const privateHelper = 1;
`;

    const symbols = await extractSymbolsFromSource('greet.ts', source, 'typescript');

    expect(symbols).toContainEqual({ file: 'greet.ts', name: 'greet', kind: 'function', line: 2 });
    expect(symbols).toContainEqual({ file: 'greet.ts', name: 'Greeter', kind: 'class', line: 6 });
    expect(symbols).toContainEqual({ file: 'greet.ts', name: 'GreetOptions', kind: 'interface', line: 10 });
    expect(symbols).toContainEqual({ file: 'greet.ts', name: 'GreetResult', kind: 'type', line: 14 });
    expect(symbols).toContainEqual({ file: 'greet.ts', name: 'defaultGreeting', kind: 'const', line: 16 });
    expect(symbols.find((symbol) => symbol.name === 'privateHelper')).toBeUndefined();
  });

  it('extracts a function and class from Python', async () => {
    const source = `
def greet(name):
    return "hi " + name


class Greeter:
    def greet(self):
        pass
`;

    const symbols = await extractSymbolsFromSource('greet.py', source, 'python');

    expect(symbols).toContainEqual({ file: 'greet.py', name: 'greet', kind: 'function', line: 2 });
    expect(symbols).toContainEqual({ file: 'greet.py', name: 'Greeter', kind: 'class', line: 6 });
  });
});
