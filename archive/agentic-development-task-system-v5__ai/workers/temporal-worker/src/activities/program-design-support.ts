import { randomUUID } from 'node:crypto';
import type { ImplementationPlan, ProgramDesign, DesignSignature } from '@awb/domain';

interface ProgramDesignJson {
  fileTreeDiff?: string[];
  typeSignatures?: Array<{ signature?: string; intent?: string }>;
  functionSignatures?: Array<{ signature?: string; intent?: string }>;
}

/**
 * The instruction handed to the program-design session. It sees the accepted plan and must
 * emit the projected structure — file-tree diff + type/function signatures WITH one-line intents but
 * NO bodies — as a JSON block. Mirrors `plannerInstruction`'s contract so the parse/gate can check it.
 */
export function programDesignInstruction(plan: ImplementationPlan): string {
  return [
    `Produce a PROGRAM DESIGN for this plan: ${plan.summary}.`,
    'Give the structure BEFORE any code — files added/changed, key type/interface definitions, and',
    'function signatures, each with a one-line intent and NO implementation bodies. Respond with a',
    'fenced ```json code block of the form',
    '{"fileTreeDiff": string[] (each "+ path (note)" or "~ path (note)"),',
    '"typeSignatures": [{"signature": string, "intent": string}],',
    '"functionSignatures": [{"signature": string, "intent": string}]}.',
    'Signatures ONLY: a "signature" containing a statement body (a "{ ... }" block) is rejected.',
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
 * A signature is "bodyless" when it does not embed a `{ ... }` block containing executable statements.
 * A design artifact legitimately carries type structure in its signatures — a TS interface / type
 * literal / class shape, or an inline object return type like `Promise<{ rows: Record<string, T>[];
 * total: number }>`. Those are declarations, not bodies, even though they use `;`/`,` and nested
 * generics. Only unambiguous statement markers signal a leaked implementation: an explicit `return`,
 * control flow (`if`/`for`/`while`/`switch (…)`), an `await`, or a bare `const|let|var` declaration
 * inside the braces. This avoids the fragile member-splitting that mis-flagged commas inside generic
 * type arguments, and it deliberately does NOT flag a `=>`: a function-type member such as
 * `interface Props { onClick: () => void }` is a legitimate declaration, not an arrow body — a real
 * leaked arrow body carries one of the statement markers above (or a `return`) and is caught by those.
 */
export function signatureIsBodyless(signature: string): boolean {
  const braceBody = signature.match(/\{([\s\S]*)\}/);
  if (!braceBody) return true;
  const inner = (braceBody[1] ?? '').trim();
  if (inner.length === 0) return true;
  return !/\breturn\b|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\bswitch\s*\(|\bawait\b|\b(?:const|let|var)\s/.test(
    inner,
  );
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
