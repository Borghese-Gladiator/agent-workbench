import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { SyntaxNode } from 'web-tree-sitter';
import { createParser, type ParserLanguage } from './parser.js';
import type { Edge } from './types.js';

function stringLiteralText(node: SyntaxNode): string | undefined {
  const stringNode = node.namedChildren.find((child) => child.type === 'string');
  const fragment = stringNode?.namedChildren.find((child) => child.type === 'string_fragment');
  return fragment?.text;
}

function collectSpecifiers(rootNode: SyntaxNode): string[] {
  const specifiers: string[] = [];

  for (const node of rootNode.namedChildren) {
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const specifier = stringLiteralText(node);
      if (specifier) {
        specifiers.push(specifier);
      }
    }

    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const declarator of node.namedChildren.filter((child) => child.type === 'variable_declarator')) {
        const call = declarator.namedChildren.find((child) => child.type === 'call_expression');
        const callee = call?.namedChildren[0];
        if (callee?.type === 'identifier' && callee.text === 'require') {
          const args = call?.namedChildren.find((child) => child.type === 'arguments');
          const stringArg = args?.namedChildren.find((child) => child.type === 'string');
          const fragment = stringArg?.namedChildren.find((child) => child.type === 'string_fragment');
          if (fragment) {
            specifiers.push(fragment.text);
          }
        }
      }
    }
  }

  return specifiers;
}

function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }

  const resolved = resolve(dirname(fromFile), specifier);
  const withoutJsExt = resolved.replace(/\.jsx?$/, '');
  const candidates = [
    resolved,
    `${withoutJsExt}.ts`,
    `${withoutJsExt}.tsx`,
    `${withoutJsExt}/index.ts`,
    `${withoutJsExt}/index.tsx`,
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export async function extractImportEdges(
  file: string,
  source: string,
  language: ParserLanguage,
): Promise<Edge[]> {
  if (language === 'python') {
    return [];
  }

  const parser = await createParser(language);
  const tree = parser.parse(source);
  const specifiers = collectSpecifiers(tree.rootNode);

  const edges: Edge[] = [];
  for (const specifier of specifiers) {
    const resolved = resolveRelativeImport(file, specifier);
    if (resolved) {
      edges.push({ from: file, to: resolved });
    }
  }
  return edges;
}
