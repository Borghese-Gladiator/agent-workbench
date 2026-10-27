/**
 * Deterministic mock artifact bodies. In a later increment these become real
 * outputs from agents/validation runners; for now they let us exercise the full
 * lifecycle without any agent integration.
 */

import type { ArtifactKind } from './artifacts.js';

export interface MockArtifactInput {
  taskTitle: string;
  rawRequest: string;
  /**
   * Reviewer feedback from a rejected prior brief. When present, the next
   * `task_brief` body incorporates it — this is the real data flow a live model
   * would consume; the mock surfaces it so regeneration is visibly different.
   */
  rejectionFeedback?: string;
}

export function mockArtifactTitle(kind: ArtifactKind): string {
  const map: Record<ArtifactKind, string> = {
    raw_prompt: 'Raw Request',
    task_brief: 'Task Brief',
    discovery: 'Discovery Notes',
    baseline_evidence: 'Baseline Evidence',
    execution_plan: 'Execution Plan',
    validation_report: 'Validation Report',
    demo_evidence: 'Demo Evidence',
    self_review: 'Agent Self-Review',
    bounce_packet: 'Bounce Packet',
    delivery_package: 'Delivery Package',
    log: 'Log',
    diff: 'Diff',
  };
  return map[kind];
}

export function mockArtifactBody(kind: ArtifactKind, input: MockArtifactInput): string {
  const { taskTitle, rawRequest, rejectionFeedback } = input;
  const header = `# ${mockArtifactTitle(kind)}\n\nTask: ${taskTitle}\n`;
  switch (kind) {
    case 'raw_prompt':
      return `${header}\n## Raw request\n\n${rawRequest}\n`;
    case 'task_brief': {
      const feedback = rejectionFeedback?.trim()
        ? `## Revision feedback addressed\n\n${rejectionFeedback.trim()}\n\n` +
          `## Proposed outcome\n\n(mock) Revised per the feedback above.\n\n`
        : `## Proposed outcome\n\n(mock) A concise statement of what success looks like.\n\n`;
      return (
        `${header}\n## Problem\n\n${rawRequest}\n\n` +
        feedback +
        // The durable contract: stable criterion IDs every later stage binds to.
        `## Acceptance Criteria\n\n` +
        `| ID | Requirement | Risk (H/M/L) |\n` +
        `| --- | --- | --- |\n` +
        `| AC1 | (mock) The headline behavior works end to end. | M |\n` +
        `| AC2 | (mock) An edge case is handled gracefully. | L |\n\n` +
        `## Open assumptions / interpretation decisions\n\n` +
        `- (mock) Where the normalized brief narrowed or reinterpreted the raw request.\n\n` +
        `## Out of scope\n\n(mock) Items intentionally deferred.\n`
      );
    }
    case 'discovery':
      return (
        `${header}\n## Relevant areas\n\n- (mock) src/ modules touched by this change\n` +
        `- (mock) tests that cover the area\n\n## Risks\n\n- (mock) none identified yet\n`
      );
    case 'baseline_evidence':
      // Placeholder only — used when agentRuntime is 'mock' or no commands are
      // configured. Real projects get actual pre-change static-analysis output.
      return (
        `${header}\n## Pre-change state (placeholder)\n\n` +
        `- test suite: (mock) n/a\n- lint: (mock) n/a\n- typecheck: (mock) n/a\n\n` +
        `> Real baseline evidence is captured for claude-runtime projects with commands configured.\n`
      );
    case 'execution_plan': {
      const revised = rejectionFeedback?.trim()
        ? `## Revision feedback addressed\n\n${rejectionFeedback.trim()}\n\n`
        : '';
      return (
        `${header}\n${revised}## Findings\n\n- (mock) src/ modules touched by this change\n` +
        `- (mock) existing pattern to follow\n\n` +
        `## Chosen approach\n\n(mock) The single approach committed to after discovery.\n\n` +
        // Per-file change list, concrete enough to apply without re-reading.
        `## Changes\n\n` +
        `### src/example.ts — modify\n\n(mock) update \`doThing()\` to take the new arg.\n\n` +
        `### src/new-file.ts — create\n\n(mock) new module exporting \`helper()\`.\n\n` +
        `## Test plan\n\n- unit: (mock)\n- manual: (mock)\n\n` +
        // Bind each brief criterion ID to how it will be proven.
        `## Validation by criterion\n\n` +
        `| Criterion ID | Validation method | Test type | Automated? |\n` +
        `| --- | --- | --- | --- |\n` +
        `| AC1 | (mock) unit test of the headline behavior | unit | yes |\n` +
        `| AC2 | (mock) e2e walkthrough of the edge case | e2e | yes |\n`
      );
    }
    case 'validation_report':
      return (
        `${header}\n## Results\n\n- test: (mock) PASS\n- lint: (mock) PASS\n` +
        `- typecheck: (mock) PASS\n- e2e: (mock) SKIPPED\n\n` +
        // Per-scenario gate: a scenario only proves the change if it would have
        // failed before it. Plus the criterion ID -> proving scenario map.
        `## Would this have failed before this change?\n\n` +
        `- (mock) AC1 scenario: yes — fails on pre-change code.\n\n` +
        `## Criterion coverage\n\n` +
        `| Criterion ID | Proving scenario |\n` +
        `| --- | --- |\n` +
        `| AC1 | (mock) headline-behavior scenario |\n` +
        `| AC2 | (mock) edge-case scenario |\n`
      );
    case 'demo_evidence':
      return `${header}\n## Demo\n\n(mock) Description of the behavior demonstrated.\n`;
    case 'self_review':
      return (
        `${header}\n## Self-review checklist\n\n- [x] (mock) matches the plan\n` +
        `- [x] (mock) tests added\n- [x] (mock) no obvious regressions\n`
      );
    case 'bounce_packet': {
      const why = rejectionFeedback?.trim()
        ? rejectionFeedback.trim()
        : '(mock) Reviewer feedback summarized here.';
      return `${header}\n## Why bounced\n\n${why}\n\n## Required changes\n\n- (mock) change one\n`;
    }
    case 'delivery_package':
      return (
        `${header}\n## Delivery summary\n\n(mock) What is being delivered.\n\n` +
        `## Target\n\n(mock) Squash-merge to default branch, or a draft PR — decided by the project's delivery policy at approval.\n`
      );
    case 'log':
      return `${header}\n(mock) log line\n`;
    case 'diff':
      return `${header}\n\`\`\`diff\n+ (mock) added line\n- (mock) removed line\n\`\`\`\n`;
    default:
      return header;
  }
}
