import { z } from 'zod';
import { originSchema, printableAscii, LIMITS, jsonByteMax } from './limits';
import { parametersSchema, sourceRefSchema, confidenceSchema } from './entities';

export const observedSchema = z
  .object({
    title: z.string().min(1).max(LIMITS.title),
    given: z.string().min(1).max(LIMITS.gwt),
    when: z.string().min(1).max(LIMITS.gwt),
    then: z.string().min(1).max(LIMITS.gwt),
    parameters: parametersSchema,
    source_ref: sourceRefSchema,
    schema_version: z.string().min(1).max(32),
  })
  .refine(jsonByteMax(LIMITS.observedBytes), `observed は ${LIMITS.observedBytes} bytes 以内`);

export const observationSchema = z.object({
  external_ref: printableAscii(LIMITS.externalRef),
  fingerprint: printableAscii(LIMITS.fingerprint),
  observed: observedSchema,
  confidence: confidenceSchema.optional(),
  source_ref: sourceRefSchema.optional(),
});
export const syncStartInput = z.object({ origin: originSchema });
export const MAX_CHUNK_SIZE = 500; // sync-protocol.md「1 chunk ≤500 観測」
export const syncChunkInput = z.object({ observations: z.array(observationSchema).min(1).max(MAX_CHUNK_SIZE) });
