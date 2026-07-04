import { describe, it, expect } from 'vitest';
import { passwordSchema, originSchema, nameSchema, emailSchema, repoUrlSchema, LIMITS } from '../../src/schemas/limits';
import {
  createTestCaseInput, bulkInput,
  setupInput, loginInput, changePasswordInput, createUserInput, patchUserInput, resetPasswordInput,
  createProjectInput, patchProjectInput, createTokenInput, patchTestCaseInput,
  listTestCasesQuery, pageQuery, observationsQuery,
} from '../../src/schemas/api';
import { parametersSchema, metadataSchema, sourceRefSchema, confidenceSchema } from '../../src/schemas/entities';
import { observationSchema, syncStartInput, syncChunkInput, MAX_CHUNK_SIZE } from '../../src/schemas/sync';

/** JSON バイト数を正確に狙うためのヘルパー(byte 上限 refine の境界を ±1 byte で検証する)。 */
const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

describe('schemas', () => {
  it('password: 8..128 文字(D-06)', () => {
    expect(passwordSchema.safeParse('a'.repeat(7)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(8)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
  it('origin: 小文字英数と -_. のみ・最大128(api-reference)', () => {
    expect(originSchema.safeParse('discovery-v1').success).toBe(true);
    expect(originSchema.safeParse('Discovery').success).toBe(false);
    expect(originSchema.safeParse('a'.repeat(128)).success).toBe(true);
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
    expect(bulkInput.safeParse({ ids: Array.from({ length: 100 }, (_, i) => `id-${i}`), action: 'approve' }).success).toBe(true);
  });
  it('observation: external_ref/fingerprint は printable ASCII ≤512、observed のバイト上限を検証(D-07)', () => {
    const ok = observationSchema.safeParse({
      external_ref: 'com.example.T#m', fingerprint: 'sha256:abc',
      observed: { title: 't', given: 'g', when: 'w', then: 't', parameters: [], source_ref: {}, schema_version: '1.0' },
    });
    expect(ok.success).toBe(true);
    expect(observationSchema.safeParse({ external_ref: '日本語', fingerprint: 'f', observed: { title: 't', given: 'g', when: 'w', then: 't', parameters: [], source_ref: {}, schema_version: '1' } }).success).toBe(false);
    // Test byte refine via unbounded source_ref field (not title which has 200 char limit)
    const oversized = { title: 't', given: 'g', when: 'w', then: 't', parameters: [], source_ref: { blob: 'x'.repeat(LIMITS.observedBytes) }, schema_version: '1' };
    expect(observationSchema.safeParse({ external_ref: 'r', fingerprint: 'f', observed: oversized }).success).toBe(false);
  });
  // task-15-brief.md「もう1つの docs ギャップ」: observation のトップレベル任意フィールド category(enum)。
  it('observation: category は任意の enum(未指定可・不正値は拒否)', () => {
    const base = {
      external_ref: 'com.example.T#m', fingerprint: 'sha256:abc',
      observed: { title: 't', given: 'g', when: 'w', then: 't', parameters: [], source_ref: {}, schema_version: '1.0' },
    };
    expect(observationSchema.safeParse(base).success).toBe(true); // 未指定は許容
    expect(observationSchema.safeParse({ ...base, category: 'boundary' }).success).toBe(true);
    expect(observationSchema.safeParse({ ...base, category: 'not-a-real-category' }).success).toBe(false);
  });
});

// ============================================================================
// B1(HANDOVER §4.2): ルート統合テスト経由でしか検証されていなかった入力スキーマの直接単体テスト。
// 方針: 文字数境界は min-1/min/max/max+1、enum は正値+不正値、byte 上限は JSON オーバーヘッドを
// 動的計算して ±1 byte、各オブジェクトスキーマで parsed.data の distinct 値エコーを最低 1 箇所
// (型が通るだけの偽 green を防ぐ識別テスト原則)。
// ============================================================================

describe('B1: limits の葉スキーマ', () => {
  it('nameSchema: 1..100 文字', () => {
    expect(nameSchema.safeParse('').success).toBe(false);
    expect(nameSchema.safeParse('x').success).toBe(true);
    expect(nameSchema.safeParse('x'.repeat(100)).success).toBe(true);
    expect(nameSchema.safeParse('x'.repeat(101)).success).toBe(false);
  });
  it('emailSchema: email 形式 + 最大254', () => {
    expect(emailSchema.safeParse('a@example.com').success).toBe(true);
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    const local242 = 'a'.repeat(242); // 242 + '@example.com'(12) = 254
    expect(emailSchema.safeParse(`${local242}@example.com`).success).toBe(true);
    expect(emailSchema.safeParse(`a${local242}@example.com`).success).toBe(false); // 255
  });
  it('repoUrlSchema: http/https の URL のみ・最大2000', () => {
    expect(repoUrlSchema.safeParse('https://github.com/example/repo.git').success).toBe(true);
    expect(repoUrlSchema.safeParse('http://internal.example/repo').success).toBe(true);
    expect(repoUrlSchema.safeParse('ftp://example.com/repo').success).toBe(false);
    expect(repoUrlSchema.safeParse('not a url').success).toBe(false);
    const base = 'https://example.com/'; // 20 文字
    expect(repoUrlSchema.safeParse(base + 'a'.repeat(LIMITS.repoUrl - base.length)).success).toBe(true);
    expect(repoUrlSchema.safeParse(base + 'a'.repeat(LIMITS.repoUrl - base.length + 1)).success).toBe(false);
  });
});

describe('B1: entities の共有スキーマ', () => {
  it('parametersSchema: 行 name は最大100・byte 上限 100KB を ±1 byte で識別', () => {
    expect(parametersSchema.safeParse([{ inputs: 1, expected: 2 }]).success).toBe(true); // name 省略可
    expect(parametersSchema.safeParse([{ name: 'x'.repeat(101), inputs: 1, expected: 2 }]).success).toBe(false);
    const overhead = jsonBytes([{ name: 'n', inputs: '', expected: 'e' }]);
    const atLimit = [{ name: 'n', inputs: 'x'.repeat(LIMITS.parametersBytes - overhead), expected: 'e' }];
    expect(jsonBytes(atLimit)).toBe(LIMITS.parametersBytes); // 前提の自己検証
    expect(parametersSchema.safeParse(atLimit).success).toBe(true);
    const overLimit = [{ name: 'n', inputs: 'x'.repeat(LIMITS.parametersBytes - overhead + 1), expected: 'e' }];
    expect(parametersSchema.safeParse(overLimit).success).toBe(false);
  });
  it('metadataSchema: record + byte 上限 10KB を ±1 byte で識別', () => {
    expect(metadataSchema.safeParse({ tags: ['a'] }).success).toBe(true);
    expect(metadataSchema.safeParse('not-a-record').success).toBe(false);
    const overhead = jsonBytes({ blob: '' });
    const atLimit = { blob: 'x'.repeat(LIMITS.metadataBytes - overhead) };
    expect(jsonBytes(atLimit)).toBe(LIMITS.metadataBytes);
    expect(metadataSchema.safeParse(atLimit).success).toBe(true);
    expect(metadataSchema.safeParse({ blob: 'x'.repeat(LIMITS.metadataBytes - overhead + 1) }).success).toBe(false);
  });
  it('sourceRefSchema: record(非オブジェクトは拒否)', () => {
    expect(sourceRefSchema.safeParse({}).success).toBe(true);
    expect(sourceRefSchema.safeParse({ file: 'a.ts', line: 42 }).success).toBe(true);
    expect(sourceRefSchema.safeParse('string').success).toBe(false);
  });
  it('confidenceSchema: 0..1 の数値', () => {
    expect(confidenceSchema.safeParse(0).success).toBe(true);
    expect(confidenceSchema.safeParse(1).success).toBe(true);
    expect(confidenceSchema.safeParse(-0.1).success).toBe(false);
    expect(confidenceSchema.safeParse(1.1).success).toBe(false);
    expect(confidenceSchema.safeParse('0.5').success).toBe(false); // coerce しない
  });
});

describe('B1: 認証・ユーザー系入力', () => {
  it('setupInput: 4 フィールド必須、値が素通しで echo される(識別)', () => {
    const valid = {
      organization_name: 'Org-Distinct-42', admin_email: 'boss@example.com',
      admin_password: 'password-1', admin_display_name: 'Boss',
    };
    const r = setupInput.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.organization_name).toBe('Org-Distinct-42');
      expect(r.data.admin_email).toBe('boss@example.com');
    }
    expect(setupInput.safeParse({ ...valid, admin_email: undefined }).success).toBe(false);
    expect(setupInput.safeParse({ ...valid, admin_password: 'a'.repeat(7) }).success).toBe(false);
  });
  it('loginInput: password は 1..128(存在チェックであり D-06 の複雑性検証ではない)', () => {
    expect(loginInput.safeParse({ email: 'a@example.com', password: 'x' }).success).toBe(true); // min は 1
    expect(loginInput.safeParse({ email: 'a@example.com', password: '' }).success).toBe(false);
    expect(loginInput.safeParse({ email: 'a@example.com', password: 'a'.repeat(128) }).success).toBe(true);
    expect(loginInput.safeParse({ email: 'a@example.com', password: 'a'.repeat(129) }).success).toBe(false);
    expect(loginInput.safeParse({ email: 'bad', password: 'x' }).success).toBe(false);
  });
  it('changePasswordInput: current は min 1、new は 8..128(D-06)', () => {
    expect(changePasswordInput.safeParse({ current_password: 'c', new_password: 'new-pass-1' }).success).toBe(true);
    expect(changePasswordInput.safeParse({ current_password: '', new_password: 'new-pass-1' }).success).toBe(false);
    expect(changePasswordInput.safeParse({ current_password: 'c', new_password: 'a'.repeat(7) }).success).toBe(false);
  });
  it('createUserInput: role は enum、distinct 値 echo(識別)', () => {
    const r = createUserInput.safeParse({ email: 'u@example.com', password: 'password-1', display_name: 'U', role: 'viewer' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.role).toBe('viewer');
    expect(createUserInput.safeParse({ email: 'u@example.com', password: 'password-1', display_name: 'U', role: 'root' }).success).toBe(false);
  });
  it('patchUserInput: 全フィールド optional({} も可)、指定時は検証される', () => {
    expect(patchUserInput.safeParse({}).success).toBe(true);
    expect(patchUserInput.safeParse({ role: 'editor' }).success).toBe(true);
    expect(patchUserInput.safeParse({ role: 'superuser' }).success).toBe(false);
    expect(patchUserInput.safeParse({ display_name: '' }).success).toBe(false);
  });
  it('resetPasswordInput: new_password は 8..128(D-06)', () => {
    expect(resetPasswordInput.safeParse({ new_password: 'reset-pass-1' }).success).toBe(true);
    expect(resetPasswordInput.safeParse({ new_password: 'a'.repeat(7) }).success).toBe(false);
    expect(resetPasswordInput.safeParse({ new_password: 'a'.repeat(129) }).success).toBe(false);
  });
});

describe('B1: プロジェクト・トークン系入力', () => {
  it('createProjectInput: name 必須 + repo_url 任意(http/https のみ)', () => {
    const r = createProjectInput.safeParse({ name: 'distinct-project-7' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe('distinct-project-7');
      expect(r.data.repo_url).toBeUndefined();
    }
    expect(createProjectInput.safeParse({ name: '' }).success).toBe(false);
    expect(createProjectInput.safeParse({ name: 'p', repo_url: 'ftp://x/r' }).success).toBe(false);
  });
  it('patchProjectInput: {} 可・repo_url は null 可(クリア)・name は null 不可', () => {
    expect(patchProjectInput.safeParse({}).success).toBe(true);
    const r = patchProjectInput.safeParse({ repo_url: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.repo_url).toBeNull();
    expect(patchProjectInput.safeParse({ name: null }).success).toBe(false);
    expect(patchProjectInput.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
  });
  it('createTokenInput: name 1..100', () => {
    expect(createTokenInput.safeParse({ name: 'ci-token' }).success).toBe(true);
    expect(createTokenInput.safeParse({ name: '' }).success).toBe(false);
    expect(createTokenInput.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('B1: テストケース入力の境界', () => {
  const base = { title: 't', category: 'normal', given: 'g', when: 'w', then: 't' } as const;
  it('createTestCaseInput: title 200 / target 512 / gwt 10000 の各境界', () => {
    expect(createTestCaseInput.safeParse({ ...base, title: 'x'.repeat(LIMITS.title) }).success).toBe(true);
    expect(createTestCaseInput.safeParse({ ...base, title: 'x'.repeat(LIMITS.title + 1) }).success).toBe(false);
    expect(createTestCaseInput.safeParse({ ...base, target: 'x'.repeat(LIMITS.target) }).success).toBe(true);
    expect(createTestCaseInput.safeParse({ ...base, target: 'x'.repeat(LIMITS.target + 1) }).success).toBe(false);
    expect(createTestCaseInput.safeParse({ ...base, given: 'x'.repeat(LIMITS.gwt) }).success).toBe(true);
    expect(createTestCaseInput.safeParse({ ...base, given: 'x'.repeat(LIMITS.gwt + 1) }).success).toBe(false);
    expect(createTestCaseInput.safeParse({ ...base, given: '' }).success).toBe(false);
  });
  it('createTestCaseInput: confidence 0..1・target は省略可(undefined のまま)', () => {
    expect(createTestCaseInput.safeParse({ ...base, confidence: 0.5 }).success).toBe(true);
    expect(createTestCaseInput.safeParse({ ...base, confidence: 1.5 }).success).toBe(false);
    const r = createTestCaseInput.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.target).toBeUndefined();
  });
  it('patchTestCaseInput: {} 可・nullable フィールドは null 可・title は空/null 不可・status enum 検証', () => {
    expect(patchTestCaseInput.safeParse({}).success).toBe(true);
    const r = patchTestCaseInput.safeParse({ target: null, parameters: null, metadata: null, confidence: null, source_ref: null });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.target).toBeNull();
      expect(r.data.parameters).toBeNull();
    }
    expect(patchTestCaseInput.safeParse({ title: '' }).success).toBe(false);
    expect(patchTestCaseInput.safeParse({ title: null }).success).toBe(false);
    expect(patchTestCaseInput.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(patchTestCaseInput.safeParse({ status: 'approved' }).success).toBe(true);
  });
});

describe('B1: クエリスキーマ(coerce/transform の実値検証)', () => {
  it('listTestCasesQuery: boolParam は "true"/"false" のみを boolean へ変換(識別)', () => {
    const rTrue = listTestCasesQuery.safeParse({ drift: 'true' });
    expect(rTrue.success).toBe(true);
    if (rTrue.success) expect(rTrue.data.drift).toBe(true);
    const rFalse = listTestCasesQuery.safeParse({ is_stale: 'false' });
    expect(rFalse.success).toBe(true);
    if (rFalse.success) expect(rFalse.data.is_stale).toBe(false);
    expect(listTestCasesQuery.safeParse({ drift: '1' }).success).toBe(false);
    expect(listTestCasesQuery.safeParse({ drift: true }).success).toBe(false); // 文字列クエリ前提
  });
  it('listTestCasesQuery: limit は 1..100 の coerce int・既定 50、enum フィルタは不正値拒否', () => {
    const r = listTestCasesQuery.safeParse({ limit: '77' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(77); // distinct 値(既定 50 と区別)
    const rDefault = listTestCasesQuery.safeParse({});
    expect(rDefault.success).toBe(true);
    if (rDefault.success) expect(rDefault.data.limit).toBe(50);
    expect(listTestCasesQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(listTestCasesQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(listTestCasesQuery.safeParse({ limit: 'abc' }).success).toBe(false);
    expect(listTestCasesQuery.safeParse({ limit: '10.5' }).success).toBe(false); // int のみ
    expect(listTestCasesQuery.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(listTestCasesQuery.safeParse({ ownership: 'machine' }).success).toBe(true);
  });
  it('pageQuery: cursor 任意文字列 + limit 1..100 既定 50', () => {
    const r = pageQuery.safeParse({ cursor: 'opaque-cursor-string' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.cursor).toBe('opaque-cursor-string');
      expect(r.data.limit).toBe(50);
    }
    expect(pageQuery.safeParse({ limit: '100' }).success).toBe(true);
    expect(pageQuery.safeParse({ limit: '101' }).success).toBe(false);
  });
  it('observationsQuery: origin は originSchema(小文字英数と -_. のみ)', () => {
    const r = observationsQuery.safeParse({ origin: 'discovery-v1', limit: '25' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.origin).toBe('discovery-v1');
      expect(r.data.limit).toBe(25);
    }
    expect(observationsQuery.safeParse({ origin: 'Discovery' }).success).toBe(false);
    expect(observationsQuery.safeParse({}).success).toBe(true); // origin 省略可
  });
});

describe('B1: 同期プロトコル入力', () => {
  const validObservation = {
    external_ref: 'com.example.T#m', fingerprint: 'sha256:abc',
    observed: { title: 't', given: 'g', when: 'w', then: 't', parameters: [], source_ref: {}, schema_version: '1.0' },
  };
  it('syncStartInput: origin は originSchema(distinct 値 echo)', () => {
    const r = syncStartInput.safeParse({ origin: 'agent-x.v2' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.origin).toBe('agent-x.v2');
    expect(syncStartInput.safeParse({ origin: 'Agent' }).success).toBe(false);
    expect(syncStartInput.safeParse({}).success).toBe(false);
  });
  it('syncChunkInput: observations は 1..500(MAX_CHUNK_SIZE)件', () => {
    expect(syncChunkInput.safeParse({ observations: [] }).success).toBe(false);
    expect(syncChunkInput.safeParse({ observations: [validObservation] }).success).toBe(true);
    const atMax = { observations: Array.from({ length: MAX_CHUNK_SIZE }, () => validObservation) };
    expect(syncChunkInput.safeParse(atMax).success).toBe(true);
    const overMax = { observations: Array.from({ length: MAX_CHUNK_SIZE + 1 }, () => validObservation) };
    expect(syncChunkInput.safeParse(overMax).success).toBe(false);
  });
});
