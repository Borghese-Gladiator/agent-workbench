import type { RepositoryUnit } from '@awb/domain';

export type { RepositoryUnit } from '@awb/domain';

export const SYMBOL_KINDS = [
  'function',
  'class',
  'interface',
  'type',
  'const',
  'method',
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export interface SymbolRecord {
  file: string;
  name: string;
  kind: SymbolKind;
  line: number;
}

export interface Edge {
  from: string;
  to: string;
}

export interface RepositoryMap {
  units: RepositoryUnit[];
  symbols: SymbolRecord[];
  unitDependencies: Edge[];
  importGraph: Edge[];
}
