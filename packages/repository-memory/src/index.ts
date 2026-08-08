export { recordFacts } from './store.js';
export { invalidateFacts, INVALIDATED_MARKER } from './invalidate.js';
export { queryMemory, type MemoryQuery, type MemorySort } from './query.js';
export {
  compileConcepts,
  type CompleteFn,
  type CompileOptions,
  type CompileResult,
} from './compile.js';
export {
  lintMemory,
  type LintReport,
  type Contradiction,
  type ConnectionCandidate,
} from './lint.js';
export { projectMemoryToFiles, type ProjectFilesResult } from './project-files.js';
