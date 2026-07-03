import { z } from 'zod';
import { originSchema, printableAscii, LIMITS, jsonByteMax } from './limits';
import { parametersSchema, sourceRefSchema, confidenceSchema } from './entities';
import { CATEGORIES } from './enums';

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
  // task-15-brief.md「もう1つの docs ギャップ」: observed の固定キーセット(data-model.md)に category が
  // 無いが、UC-07 は「カテゴリ: Discovery が判定」とし test_cases.category は NOT NULL。そのため
  // observation のトップレベル任意フィールドとして追加する(observed の固定キーセットには含めない)。
  // 未指定時のデフォルト('normal')適用は canonical 生成(Task 16 工程1)側の責務(ここでは受理のみ)。
  // data-model.md/sync-protocol.md 未記載(Task 23 で docs に反映予定)。
  category: z.enum(CATEGORIES).optional(),
  observed: observedSchema,
  confidence: confidenceSchema.optional(),
  source_ref: sourceRefSchema.optional(),
});
export const syncStartInput = z.object({ origin: originSchema });
export const MAX_CHUNK_SIZE = 500; // sync-protocol.md「1 chunk ≤500 観測」
export const syncChunkInput = z.object({ observations: z.array(observationSchema).min(1).max(MAX_CHUNK_SIZE) });
