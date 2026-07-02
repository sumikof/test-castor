import { z } from 'zod';
import { LIMITS, jsonByteMax } from './limits';

export const parametersSchema = z
  .array(z.object({ name: z.string().max(LIMITS.name).optional(), inputs: z.unknown(), expected: z.unknown() }))
  .refine(jsonByteMax(LIMITS.parametersBytes), `parameters は ${LIMITS.parametersBytes} bytes 以内`);
export const metadataSchema = z
  .record(z.string(), z.unknown())
  .refine(jsonByteMax(LIMITS.metadataBytes), `metadata は ${LIMITS.metadataBytes} bytes 以内`);
export const sourceRefSchema = z.record(z.string(), z.unknown());
export const confidenceSchema = z.number().min(0).max(1);
