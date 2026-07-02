import { describe, it, expect } from 'vitest';
import { passwordSchema, originSchema, LIMITS } from '../../src/schemas/limits';
import { createTestCaseInput, bulkInput } from '../../src/schemas/api';
import { observationSchema } from '../../src/schemas/sync';

describe('schemas', () => {
  it('password: 8..128 文字(D-06)', () => {
    expect(passwordSchema.safeParse('a'.repeat(7)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(8)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
  it('origin: 小文字英数と -_. のみ・最大128(api-reference)', () => {
    expect(originSchema.safeParse('discovery-v1').success).toBe(true);
    expect(originSchema.safeParse('Discovery').success).toBe(false);
    expect(originSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
  it('testcase 作成: 必須は title/category/given/when/then、status 既定 draft', () => {
    const r = createTestCaseInput.safeParse({
      title: 't', category: 'normal', given: 'g', when: 'w', then: 't',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.status).toBe('draft');
    expect(createTestCaseInput.safeParse({ title: 't', category: 'bad', given: 'g', when: 'w', then: 't' }).success).toBe(false);
  });
  it('bulk: ids は 1..100 件、action は approve/archive/restore', () => {
    expect(bulkInput.safeParse({ ids: [], action: 'approve' }).success).toBe(false);
    expect(bulkInput.safeParse({ ids: Array.from({ length: 101 }, (_, i) => `id-${i}`), action: 'approve' }).success).toBe(false);
    expect(bulkInput.safeParse({ ids: ['a'], action: 'restore' }).success).toBe(true);
  });
  it('observation: external_ref/fingerprint は printable ASCII ≤512、observed のバイト上限を検証(D-07)', () => {
    const ok = observationSchema.safeParse({
      external_ref: 'com.example.T#m', fingerprint: 'sha256:abc',
      observed: { title: 't', given: 'g', when: 'w', then: 't', parameters: [], source_ref: {}, schema_version: '1.0' },
    });
    expect(ok.success).toBe(true);
    expect(observationSchema.safeParse({ external_ref: '日本語', fingerprint: 'f', observed: { title: 't', given: 'g', when: 'w', then: 't', parameters: [], source_ref: {}, schema_version: '1' } }).success).toBe(false);
    const big = { title: 'x'.repeat(LIMITS.observedBytes), given: 'g', when: 'w', then: 't', parameters: [], source_ref: {}, schema_version: '1' };
    expect(observationSchema.safeParse({ external_ref: 'r', fingerprint: 'f', observed: big }).success).toBe(false);
  });
});
