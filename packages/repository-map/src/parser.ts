import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';

export type ParserLanguage = 'typescript' | 'tsx' | 'python';

const require = createRequire(import.meta.url);

function resolveWasmPath(name: string): string {
  return require.resolve(`tree-sitter-wasms/out/${name}.wasm`);
}

const WASM_FILES: Record<ParserLanguage, string> = {
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-tsx',
  python: 'tree-sitter-python',
};

let initPromise: Promise<void> | undefined;
const languageCache = new Map<ParserLanguage, Parser.Language>();

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  await initPromise;
}

export async function loadLanguage(language: ParserLanguage): Promise<Parser.Language> {
  await ensureInit();
  const cached = languageCache.get(language);
  if (cached) {
    return cached;
  }
  const wasmPath = resolveWasmPath(WASM_FILES[language]);
  const loaded = await Parser.Language.load(wasmPath);
  languageCache.set(language, loaded);
  return loaded;
}

export async function createParser(language: ParserLanguage): Promise<Parser> {
  await ensureInit();
  const parser = new Parser();
  const grammar = await loadLanguage(language);
  parser.setLanguage(grammar);
  return parser;
}

export function languageForFile(filePath: string): ParserLanguage | undefined {
  if (filePath.endsWith('.tsx')) {
    return 'tsx';
  }
  if (filePath.endsWith('.ts')) {
    return 'typescript';
  }
  if (filePath.endsWith('.py')) {
    return 'python';
  }
  return undefined;
}
