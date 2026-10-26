import type { SyntaxNode } from 'web-tree-sitter';
import { createParser, languageForFile, type ParserLanguage } from './parser.js';
import type { SymbolKind, SymbolRecord } from './types.js';

function nameOf(node: SyntaxNode): string | undefined {
  const nameNode =
    node.childForFieldName('name') ??
    node.namedChildren.find((child) => child.type === 'identifier' || child.type === 'type_identifier');
  return nameNode?.text;
}

function lineOf(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function extractTypescriptSymbols(rootNode: SyntaxNode, file: string): SymbolRecord[] {
  const records: SymbolRecord[] = [];

  for (const topLevel of rootNode.namedChildren) {
    const isExport = topLevel.type === 'export_statement';
    const declaration = isExport
      ? (topLevel.namedChildren.find((child) =>
          [
            'function_declaration',
            'class_declaration',
            'interface_declaration',
            'type_alias_declaration',
            'lexical_declaration',
          ].includes(child.type),
        ) ?? undefined)
      : topLevel;

    if (!declaration) {
      continue;
    }

    switch (declaration.type) {
      case 'function_declaration': {
        const name = nameOf(declaration);
        if (name) {
          records.push({ file, name, kind: 'function', line: lineOf(declaration) });
        }
        break;
      }
      case 'class_declaration': {
        const name = nameOf(declaration);
        if (name) {
          records.push({ file, name, kind: 'class', line: lineOf(declaration) });
        }
        break;
      }
      case 'interface_declaration': {
        if (isExport) {
          const name = nameOf(declaration);
          if (name) {
            records.push({ file, name, kind: 'interface', line: lineOf(declaration) });
          }
        }
        break;
      }
      case 'type_alias_declaration': {
        if (isExport) {
          const name = nameOf(declaration);
          if (name) {
            records.push({ file, name, kind: 'type', line: lineOf(declaration) });
          }
        }
        break;
      }
      case 'lexical_declaration': {
        if (isExport) {
          for (const declarator of declaration.namedChildren.filter(
            (child) => child.type === 'variable_declarator',
          )) {
            const name = declarator.childForFieldName('name')?.text;
            if (name) {
              records.push({ file, name, kind: 'const', line: lineOf(declarator) });
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return records;
}

function extractPythonSymbols(rootNode: SyntaxNode, file: string): SymbolRecord[] {
  const records: SymbolRecord[] = [];
  const kindByNodeType: Record<string, SymbolKind> = {
    function_definition: 'function',
    class_definition: 'class',
  };

  for (const topLevel of rootNode.namedChildren) {
    const kind = kindByNodeType[topLevel.type];
    if (!kind) {
      continue;
    }
    const name = nameOf(topLevel);
    if (name) {
      records.push({ file, name, kind, line: lineOf(topLevel) });
    }
  }

  return records;
}

export async function extractSymbolsFromSource(
  file: string,
  source: string,
  language: ParserLanguage,
): Promise<SymbolRecord[]> {
  const parser = await createParser(language);
  const tree = parser.parse(source);
  if (language === 'python') {
    return extractPythonSymbols(tree.rootNode, file);
  }
  return extractTypescriptSymbols(tree.rootNode, file);
}

export function detectLanguage(filePath: string): ParserLanguage | undefined {
  return languageForFile(filePath);
}
