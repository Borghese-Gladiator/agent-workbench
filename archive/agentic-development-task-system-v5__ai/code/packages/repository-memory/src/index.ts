export { recordFacts, type RecordFactsResult } from './store.js';
export {
  qualifiesForPromotion,
  evictSupersededFacts,
  STALE_AFTER_OBSERVATIONS,
  STALE_MARKER,
  type PromotionVerdict,
  type EvictionResult,
} from './lifecycle.js';
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
