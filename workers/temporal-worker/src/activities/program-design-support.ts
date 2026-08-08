import { randomUUID } from 'node:crypto';
import type { ImplementationPlan, ProgramDesign, DesignSignature } from '@awb/domain';

interface ProgramDesignJson {
  fileTreeDiff?: string[];
  typeSignatures?: Array<{ signature?: string; intent?: string }>;
  functionSignatures?: Array<{ signature?: string; intent?: string }>;
}

/**
 * The instruction handed to the program-design session (TASK-52). It sees the accepted plan and must
 * emit the projected structure — file-tree diff + type/function signatures WITH one-line intents but
 * NO bodies — as a JSON block. Mirrors `plannerInstruction`'s contract so the parse/gate can check it.
 */
export function programDesignInstruction(plan: ImplementationPlan): string {
  return [
    `Produce a PROGRAM DESIGN for this plan: ${plan.summary}.`,
    'Decide the structure BEFORE any code: which files are added/changed, the key type/interface',
    'definitions, and the function signatures — each with a one-line intent, and NO implementation',
    'bodies. Respond with a JSON object as a fenced ```json code block of the form',
    '{"fileTreeDiff": string[] (each "+ path (note)" or "~ path (note)"),',
    '"typeSignatures": [{"signature": string, "intent": string}],',
    '"functionSignatures": [{"signature": string, "intent": string}]}.',
    'Signatures ONLY — if a "signature" contains a function body (a "{ ... }" block with statements),',
    'the design will be rejected. Keep it to declarations + intents.',
  ].join(' ');
}

function extractJsonBlock(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const brace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (brace !== -1 && lastBrace > brace) return text.slice(brace, lastBrace + 1);
  return undefined;
}

function toSignatures(raw: Array<{ signature?: string; intent?: string }> | undefined): DesignSignature[] {
  return (raw ?? [])
    .filter((s) => typeof s.signature === 'string' && s.signature.trim().length > 0)
    .map((s) => ({ signature: s.signature as string, intent: (s.intent ?? '').trim() }));
}

/**
 * A signature is "bodyless" when it does not embed a `{ ... }` block containing statements. Design
 * declarations (a TS interface's `{ field: T }` shape is fine — no `;`-terminated statements/`return`)
 * pass; a pasted function body does not. Deliberately conservative: flags obvious implementation leaks.
 */
export function signatureIsBodyless(signature: string): boolean {
  const braceBody = signature.match(/\{([\s\S]*)\}/);
  if (!braceBody) return true;
  const inner = braceBody[1] ?? '';
  // A `return`, a `;`-terminated statement, or control flow inside the braces means a body leaked in.
  return !/\breturn\b|;|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(/.test(inner);
}

export interface ParsedProgramDesign {
  design: ProgramDesign;
  allSignaturesBodyless: boolean;
}

/**
 * Parses a program-design session's textual output into a `ProgramDesign`. Returns undefined when
 * nothing usable is present so the caller can fall back or block. Reports whether every signature is
 * bodyless so the gate can reject a design that leaked implementation.
 */
export function parseProgramDesignOutput(
  text: string,
  plan: ImplementationPlan,
): ParsedProgramDesign | undefined {
  const block = extractJsonBlock(text);
  if (!block) return undefined;

  let parsed: ProgramDesignJson;
  try {
    parsed = JSON.parse(block) as ProgramDesignJson;
  } catch {
    return undefined;
  }

  const fileTreeDiff = (parsed.fileTreeDiff ?? []).filter((f) => typeof f === 'string' && f.trim().length > 0);
  const typeSignatures = toSignatures(parsed.typeSignatures);
  const functionSignatures = toSignatures(parsed.functionSignatures);
  if (fileTreeDiff.length === 0 && typeSignatures.length === 0 && functionSignatures.length === 0) {
    return undefined;
  }

  const allSignaturesBodyless = [...typeSignatures, ...functionSignatures].every((s) =>
    signatureIsBodyless(s.signature),
  );

  return {
    design: {
      id: randomUUID(),
      taskId: plan.taskId,
      planVersion: plan.version,
      version: 1,
      fileTreeDiff,
      typeSignatures,
      functionSignatures,
    },
    allSignaturesBodyless,
  };
}
