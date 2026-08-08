import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TASK-64 regression guard. The app rendered unstyled because JSX referenced
 * layout/semantic class names (`app-shell`, `app-nav`, `error`, `note`, `actions`,
 * `repository-path`, `task-facts`, …) that were defined nowhere — neither a Tailwind
 * utility nor a project stylesheet rule. This test fails when a static `className`
 * string literal contains a token that is neither a recognized Tailwind utility nor
 * an explicitly allow-listed project class, so a used-but-undefined class name cannot
 * silently return.
 *
 * Scope + limits: it inspects string-literal `className="…"` and `className={'…'}`
 * occurrences (the case that broke us). Class names composed dynamically (template
 * strings, `cn(...)` with variables, `cva` variant maps) are out of scope — those live
 * inside the shadcn component kit and are exercised by rendering tests.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Non-Tailwind class names that are legitimately defined for the project. `dark` is the
 * theme class carried on <html> (see styles.css). Add a name here only when a matching
 * CSS rule actually exists.
 */
const ALLOWED_PROJECT_CLASSES = new Set<string>(['dark']);

/**
 * Tailwind utility recognizer. A token is treated as a utility if it matches one of these
 * shapes. This is deliberately broad on the utility side (false-accepting a made-up
 * utility is caught by the browser, and Tailwind's own build warns on unknown ones) and
 * strict on the semantic side: the orphaned names that broke us (`app-shell`, `error`,
 * `note`, `actions`, `gate-panel`, `event-timeline`, …) match none of these.
 */
const UTILITY_PATTERNS: RegExp[] = [
  // Variant prefixes: hover:, focus-visible:, sm:, data-[state=open]:, group-hover:, etc.
  // Strip them and re-check the base below, so we only need base-utility shapes here.
];

// Known Tailwind utility base prefixes (the segment before the first `-`, or the whole
// token for prefix-less utilities like `flex`, `grid`, `block`, `truncate`).
const UTILITY_PREFIXES = new Set<string>([
  'flex',
  'grid',
  'inline',
  'block',
  'hidden',
  'table',
  'contents',
  'flow',
  'items',
  'justify',
  'content',
  'self',
  'place',
  'gap',
  'order',
  'col',
  'row',
  'p',
  'px',
  'py',
  'pt',
  'pb',
  'pl',
  'pr',
  'ps',
  'pe',
  'm',
  'mx',
  'my',
  'mt',
  'mb',
  'ml',
  'mr',
  'ms',
  'me',
  'space',
  'w',
  'h',
  'min',
  'max',
  'size',
  'aspect',
  'basis',
  'shrink',
  'grow',
  'flex-1',
  'text',
  'font',
  'leading',
  'tracking',
  'align',
  'whitespace',
  'break',
  'truncate',
  'uppercase',
  'lowercase',
  'capitalize',
  'normal',
  'tabular',
  'line',
  'list',
  'underline',
  'bg',
  'from',
  'via',
  'to',
  'fill',
  'stroke',
  'border',
  'rounded',
  'ring',
  'outline',
  'divide',
  'shadow',
  'opacity',
  'blur',
  'backdrop',
  'mix',
  'absolute',
  'relative',
  'fixed',
  'sticky',
  'static',
  'top',
  'bottom',
  'left',
  'right',
  'inset',
  'z',
  'overflow',
  'overscroll',
  'object',
  'cursor',
  'select',
  'pointer',
  'resize',
  'scroll',
  'snap',
  'touch',
  'transition',
  'duration',
  'ease',
  'delay',
  'animate',
  'transform',
  'scale',
  'rotate',
  'translate',
  'skew',
  'origin',
  'sr',
  'not',
  'placeholder',
  'caret',
  'accent',
  'appearance',
  'will',
]);

function isVariantPrefixed(token: string): string {
  // Strip Tailwind variant prefixes like `hover:`, `sm:`, `data-[state=open]:`, `[&>span]:`.
  // Variants are separated by `:` but bracketed arbitrary values may contain `:` too, so we
  // split on the LAST top-level colon that is not inside brackets.
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) lastColon = i;
  }
  return lastColon === -1 ? token : token.slice(lastColon + 1);
}

function isTailwindUtility(rawToken: string): boolean {
  let token = rawToken;
  // Negative utilities: -mt-2, -translate-x-1.
  if (token.startsWith('-')) token = token.slice(1);
  // Strip variant prefixes to get the bare utility.
  token = isVariantPrefixed(token);
  if (token === '') return false;
  // Arbitrary-value or arbitrary-property utilities: [&_svg]:size-4 handled above; bare `[...]`.
  if (token.startsWith('[') && token.endsWith(']')) return true;
  for (const re of UTILITY_PATTERNS) if (re.test(token)) return true;
  // Whole-token utilities (`flex`, `grid`, `truncate`, `uppercase`, …).
  if (UTILITY_PREFIXES.has(token)) return true;
  // Prefix-`-`-suffix utilities (`text-sm`, `bg-card`, `rounded-md`, `gap-2`, `h-8`, …).
  const prefix = token.slice(0, token.indexOf('-'));
  return UTILITY_PREFIXES.has(prefix);
}

function collectTsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsxFiles(full, acc);
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Matches `className="..."` and `className={'...'}` / `className={"..."}` string literals. */
const CLASSNAME_LITERAL = /className=(?:"([^"]*)"|\{\s*['"]([^'"]*)['"]\s*\})/g;

describe('className tokens resolve to a Tailwind utility or a known project class', () => {
  const files = collectTsxFiles(SRC_DIR);

  it('scans at least the app source tree', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  const offenders: Array<{ file: string; token: string }> = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(CLASSNAME_LITERAL)) {
      const value = match[1] ?? match[2] ?? '';
      for (const token of value.split(/\s+/).filter(Boolean)) {
        if (ALLOWED_PROJECT_CLASSES.has(token)) continue;
        if (isTailwindUtility(token)) continue;
        offenders.push({ file: file.replace(`${SRC_DIR}/`, ''), token });
      }
    }
  }

  it('has no used-but-undefined class names', () => {
    expect(offenders).toEqual([]);
  });
});
