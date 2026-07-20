import { IngestEnvelopeSchema, PayloadSchemaMap } from '@shared/schemas.js';
import type { z } from 'zod';

export type ValidationSuccess = {
  valid: true;
  envelope: z.infer<typeof IngestEnvelopeSchema>;
  payload: unknown;
};

export type ValidationFailure = {
  valid: false;
  reason: string;
};

export type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Validate a raw JSON string as an ingest file.
 *
 * 1. Parse JSON
 * 2. Validate envelope against IngestEnvelopeSchema
 * 3. Look up event_type in PayloadSchemaMap
 * 4. Validate payload against specific schema
 */
export function validateIngestFile(content: string): ValidationResult {
  // Step 1: Parse JSON
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    return {
      valid: false,
      reason: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 2: Validate envelope
  const envelopeResult = IngestEnvelopeSchema.safeParse(raw);
  if (!envelopeResult.success) {
    return {
      valid: false,
      reason: `Envelope validation failed: ${envelopeResult.error.message}`,
    };
  }

  const envelope = envelopeResult.data;

  // Step 3: Look up event_type in PayloadSchemaMap
  const payloadSchema = PayloadSchemaMap[envelope.event_type];
  if (!payloadSchema) {
    return {
      valid: false,
      reason: `Unknown event_type: "${envelope.event_type}"`,
    };
  }

  // Step 4: Validate payload against specific schema
  const payloadResult = payloadSchema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    return {
      valid: false,
      reason: `Payload validation failed for "${envelope.event_type}": ${payloadResult.error.message}`,
    };
  }

  return {
    valid: true,
    envelope,
    payload: payloadResult.data,
  };
}
