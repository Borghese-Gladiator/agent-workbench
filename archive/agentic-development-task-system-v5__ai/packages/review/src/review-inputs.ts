import type { ImplementationPlan, TaskContract } from '@awb/domain';

/**
 * Everything the adversarial reviewer must be given (product spec §24): the approved task
 * contract, the accepted plan, the final diff, relevant source, tests, verification evidence,
 * QA evidence, and repository invariants. This package has no direct access to git diffs or the
 * database, so fields it cannot itself produce are modeled as strings/references the caller
 * assembles and passes in.
 */
export interface ReviewInputs {
  taskContract: TaskContract;
  plan: ImplementationPlan;
  /** The final candidate diff, as text. Produced by the caller (this package has no git access). */
  finalDiff: string;
  /** Paths to source files relevant to the change, for the reviewer to read. */
  relevantSourcePaths: string[];
  /** Paths to test files relevant to the change. */
  testPaths: string[];
  /** IDs referencing verification evidence records (this package has no evidence-store access). */
  verificationEvidenceIds: string[];
  /** IDs referencing QA evidence records. */
  qaEvidenceIds: string[];
  /** Repository invariants the reviewer should hold the change against (e.g. architectural rules). */
  repositoryInvariants: string[];
}
