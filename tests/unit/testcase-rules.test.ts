// テストケース ドメインルール(純関数)のテスト。
// data-model.md「canonical 状態機械」「状態遷移の許可マトリクス」「列の二分」「複合不変条件」、
// apis/testcases.md(PATCH 副作用・bulk 各アクションの業務ルール)、usecase.md UC-10/UC-11/UC-21 を正本とする。
import { describe, it, expect } from 'vitest';
import { HUMAN_FIELDS, canTransition, computeHumanPatch, applyBulkAction } from '../../src/domain/testcase-rules';
import { buildHistoryEntries } from '../../src/domain/history-delta';
import type { TestCaseRow } from '../../src/storage/schema';
import type { Status } from '../../src/schemas/enums';

function makeRow(overrides: Partial<TestCaseRow> = {}): TestCaseRow {
  return {
    id: 'tc-1',
    projectId: 'proj-1',
    title: 'title',
    target: null,
    category: 'normal',
    given: 'given',
    when: 'when',
    then: 'then',
    parameters: null,
    status: 'draft',
    isStale: 0,
    ownership: 'machine',
    mirrorOrigin: null,
    drift: 0,
    fingerprint: null,
    version: 1,
    confidence: null,
    sourceRef: null,
    createdOrigin: 'discovery',
    metadata: null,
    humanUpdatedAt: null,
    systemUpdatedAt: null,
    createdAt: 1000,
    ...overrides,
  };
}

describe('HUMAN_FIELDS', () => {
  it('data-model.md「人間所有列」の10列と一致する', () => {
    expect(HUMAN_FIELDS).toEqual([
      'title', 'target', 'category', 'given', 'when', 'then',
      'parameters', 'status', 'confidence', 'metadata',
    ]);
  });
});

describe('canTransition: 状態遷移の許可マトリクス(data-model.md「状態遷移の許可マトリクス」)全9組合せ', () => {
  // data-model.md のマトリクス表を1行ずつ転記(GC-1 突合)。同値(from===to)は表に無いが「no-op として許可」。
  const MATRIX: Array<[Status, Status, boolean]> = [
    ['draft', 'approved', true],     // draft → approved: ○
    ['draft', 'archived', true],     // draft → archived: ○
    ['approved', 'draft', true],     // approved → draft: ○
    ['approved', 'archived', true],  // approved → archived: ○
    ['archived', 'draft', true],     // archived → draft: ○
    ['archived', 'approved', false], // archived → approved: ✕(復帰は必ず draft を経由する)
    ['draft', 'draft', true],        // 同値 no-op: 許可
    ['approved', 'approved', true],  // 同値 no-op: 許可
    ['archived', 'archived', true],  // 同値 no-op: 許可
  ];

  it.each(MATRIX)('%s → %s は %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });
});

describe('computeHumanPatch', () => {
  it('machine 所有行のフィールド実変更で ownershipTransition=true(data-model「machine→human は不可逆」)', () => {
    const row = makeRow({ ownership: 'machine', status: 'draft', title: 'old', version: 1 });
    const result = computeHumanPatch(row, { title: 'new' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes).toEqual({ title: { before: 'old', after: 'new' } });
    expect(result.ownershipTransition).toBe(true);
    expect(result.columnValues).toEqual({ title: 'new', version: 2, ownership: 'human' });
    expect(result.statusChange).toBeNull();
  });

  it('UC-11: machine 所有 draft を編集せず status=approved のみ PATCH しても ownership は human に遷移する', () => {
    const row = makeRow({ ownership: 'machine', status: 'draft' });
    const result = computeHumanPatch(row, { status: 'approved' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.statusChange).toEqual({ from: 'draft', to: 'approved' });
    expect(result.ownershipTransition).toBe(true);
    expect(result.columnValues.ownership).toBe('human');
  });

  it('同値 PATCH(no-op)では changes が空・ownershipTransition=false・statusChange=null', () => {
    const row = makeRow({ ownership: 'machine', status: 'draft', title: 'same' });
    const result = computeHumanPatch(row, { title: 'same', status: 'draft' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes).toEqual({});
    expect(result.ownershipTransition).toBe(false);
    expect(result.columnValues).toEqual({});
    expect(result.statusChange).toBeNull();
  });

  it('未指定キーは不変(PATCH セマンティクス): given/when/then を送らなければ changes に含まれない', () => {
    const row = makeRow({ title: 'old' });
    const result = computeHumanPatch(row, { title: 'new' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(Object.keys(result.changes)).toEqual(['title']);
  });

  it('target:null による明示的クリアが changes に載る(PATCH セマンティクス「明示的null=クリア」)', () => {
    const row = makeRow({ target: 'com.example.Foo#bar', ownership: 'human' });
    const result = computeHumanPatch(row, { target: null });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes.target).toEqual({ before: 'com.example.Foo#bar', after: null });
    expect(result.columnValues.target).toBeNull();
    expect(result.ownershipTransition).toBe(false); // 既に human
  });

  it('既に null のフィールドへ null を再送する PATCH は no-op(target/parameters/metadata が全て null の行に target:null を再送しても偽陽性の変更にならない。jsonDeepEqual(null,null)===true の回帰防止)', () => {
    const row = makeRow({ ownership: 'machine', target: null, parameters: null, metadata: null });
    const result = computeHumanPatch(row, { target: null });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes).toEqual({});
    expect(result.ownershipTransition).toBe(false); // machine 所有でも実変更なしなら遷移しない
    expect(result.statusChange).toBeNull();
  });

  it('status 不正遷移(archived→approved)は invalid_transition を返す', () => {
    const row = makeRow({ status: 'archived', ownership: 'human' });
    const result = computeHumanPatch(row, { status: 'approved' });
    expect(result).toEqual({ ok: false, error: 'invalid_transition' });
  });

  it('invalid_transition の場合、同時に指定した他フィールドの変更も一切適用されない(アトミック)', () => {
    const row = makeRow({ status: 'archived', ownership: 'human', title: 'old' });
    const result = computeHumanPatch(row, { status: 'approved', title: 'new' });
    expect(result).toEqual({ ok: false, error: 'invalid_transition' });
  });

  it('status 変更と title 変更の複合: 両方が changes に載り、statusChange も設定され、version は+1のみ', () => {
    const row = makeRow({ status: 'draft', ownership: 'human', title: 'old', version: 5 });
    const result = computeHumanPatch(row, { status: 'approved', title: 'new' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes).toEqual({
      title: { before: 'old', after: 'new' },
      status: { before: 'draft', after: 'approved' },
    });
    expect(result.statusChange).toEqual({ from: 'draft', to: 'approved' });
    expect(result.columnValues.version).toBe(6);
    expect(result.ownershipTransition).toBe(false); // 既に human
  });

  it('parameters は JSON 文字列から decode して比較する: 同一内容(別参照)なら changes に載らない', () => {
    const row = makeRow({ parameters: JSON.stringify([{ inputs: { age: 1 }, expected: 'ok' }]) });
    const result = computeHumanPatch(row, { parameters: [{ inputs: { age: 1 }, expected: 'ok' }] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes.parameters).toBeUndefined();
    expect(result.columnValues.parameters).toBeUndefined();
  });

  it('parameters の内容変更: changes は decode 済みの値、columnValues は JSON 文字列化された値', () => {
    const row = makeRow({
      parameters: JSON.stringify([{ inputs: { age: 1 }, expected: 'ok' }]),
      ownership: 'human',
    });
    const next = [{ inputs: { age: 2 }, expected: 'ng' }];
    const result = computeHumanPatch(row, { parameters: next });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes.parameters).toEqual({
      before: [{ inputs: { age: 1 }, expected: 'ok' }],
      after: next,
    });
    expect(result.columnValues.parameters).toBe(JSON.stringify(next));
  });

  it('parameters:null によるクリア: columnValues.parameters は null(JSON文字列化しない)', () => {
    const row = makeRow({ parameters: JSON.stringify([{ inputs: {}, expected: 'x' }]), ownership: 'human' });
    const result = computeHumanPatch(row, { parameters: null });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes.parameters).toEqual({ before: [{ inputs: {}, expected: 'x' }], after: null });
    expect(result.columnValues.parameters).toBeNull();
  });

  it('metadata も parameters と同様に JSON decode 済み値で比較・変更検出する', () => {
    const row = makeRow({ metadata: JSON.stringify({ tags: ['a'] }), ownership: 'human' });
    const result = computeHumanPatch(row, { metadata: { tags: ['a', 'b'] } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes.metadata).toEqual({ before: { tags: ['a'] }, after: { tags: ['a', 'b'] } });
    expect(result.columnValues.metadata).toBe(JSON.stringify({ tags: ['a', 'b'] }));
  });

  it('何もキーを指定しない PATCH は完全な no-op(changes 空・columnValues 空)', () => {
    const row = makeRow({ ownership: 'machine' });
    const result = computeHumanPatch(row, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes).toEqual({});
    expect(result.columnValues).toEqual({});
    expect(result.ownershipTransition).toBe(false);
    expect(result.statusChange).toBeNull();
  });
});

describe('applyBulkAction(apis/testcases.md「POST /testcases/bulk」業務ルール、全3アクション×3状態=9combo)', () => {
  describe('approve', () => {
    it('draft(machine所有) → update + ownershipTransition=true', () => {
      const row = makeRow({ status: 'draft', ownership: 'machine' });
      expect(applyBulkAction(row, 'approve')).toEqual({ kind: 'update', newStatus: 'approved', ownershipTransition: true });
    });
    it('draft(human所有) → update + ownershipTransition=false', () => {
      const row = makeRow({ status: 'draft', ownership: 'human' });
      expect(applyBulkAction(row, 'approve')).toEqual({ kind: 'update', newStatus: 'approved', ownershipTransition: false });
    });
    it('approved → skip(既に対象ステータス)', () => {
      const row = makeRow({ status: 'approved', ownership: 'human' });
      expect(applyBulkAction(row, 'approve')).toEqual({ kind: 'skip' });
    });
    it('archived → error VALIDATION_FAILED(restore で draft に復帰してから承認する)', () => {
      const row = makeRow({ status: 'archived', ownership: 'human' });
      expect(applyBulkAction(row, 'approve')).toEqual({
        kind: 'error',
        code: 'VALIDATION_FAILED',
        message: 'cannot approve an archived test case',
      });
    });
  });

  describe('archive', () => {
    it('draft(machine所有) → update + ownershipTransition=true(複合不変条件: archived⇒ownership=human)', () => {
      const row = makeRow({ status: 'draft', ownership: 'machine' });
      expect(applyBulkAction(row, 'archive')).toEqual({ kind: 'update', newStatus: 'archived', ownershipTransition: true });
    });
    it('approved(human所有) → update + ownershipTransition=false(既に human)', () => {
      const row = makeRow({ status: 'approved', ownership: 'human' });
      expect(applyBulkAction(row, 'archive')).toEqual({ kind: 'update', newStatus: 'archived', ownershipTransition: false });
    });
    it('archived → skip(既に対象ステータス)', () => {
      const row = makeRow({ status: 'archived', ownership: 'human' });
      expect(applyBulkAction(row, 'archive')).toEqual({ kind: 'skip' });
    });
  });

  describe('restore', () => {
    it('archived → update to draft + ownershipTransition=false(archived は既に human)', () => {
      const row = makeRow({ status: 'archived', ownership: 'human' });
      expect(applyBulkAction(row, 'restore')).toEqual({ kind: 'update', newStatus: 'draft', ownershipTransition: false });
    });
    it('draft → skip(restore 対象外)', () => {
      const row = makeRow({ status: 'draft', ownership: 'human' });
      expect(applyBulkAction(row, 'restore')).toEqual({ kind: 'skip' });
    });
    it('approved → skip(archived 以外はスキップ)', () => {
      const row = makeRow({ status: 'approved', ownership: 'human' });
      expect(applyBulkAction(row, 'restore')).toEqual({ kind: 'skip' });
    });
  });
});

describe('buildHistoryEntries(usecase.md UC-21「変更履歴の確認」: status_changed と updated は別エントリ)', () => {
  it('title(他フィールド)+ status 同時変更 → updated と status_changed の2エントリ(順序: updated → status_changed)', () => {
    const changes = {
      title: { before: 'old', after: 'new' },
      status: { before: 'draft' as const, after: 'approved' as const },
    };
    const statusChange = { from: 'draft' as const, to: 'approved' as const };
    const entries = buildHistoryEntries({ changes, statusChange, actor: 'user:u1', now: 1000 });
    expect(entries).toEqual([
      { action: 'updated', delta: { title: { before: 'old', after: 'new' } } },
      { action: 'status_changed', delta: { status: { before: 'draft', after: 'approved' } } },
    ]);
  });

  it('フィールド変更のみ(status変更なし) → updated 1エントリのみ', () => {
    const changes = { title: { before: 'a', after: 'b' } };
    const entries = buildHistoryEntries({ changes, statusChange: null, actor: 'user:u1', now: 1000 });
    expect(entries).toEqual([{ action: 'updated', delta: { title: { before: 'a', after: 'b' } } }]);
  });

  it('status 変更のみ(他フィールド変更なし) → status_changed 1エントリのみ(delta は status のみ)', () => {
    const changes = { status: { before: 'draft' as const, after: 'approved' as const } };
    const statusChange = { from: 'draft' as const, to: 'approved' as const };
    const entries = buildHistoryEntries({ changes, statusChange, actor: 'user:u1', now: 1000 });
    expect(entries).toEqual([{ action: 'status_changed', delta: { status: { before: 'draft', after: 'approved' } } }]);
  });

  it('変更なし → 空配列', () => {
    const entries = buildHistoryEntries({ changes: {}, statusChange: null, actor: 'user:u1', now: 1000 });
    expect(entries).toEqual([]);
  });

  it('複数フィールド変更時、updated の delta に status を含めない', () => {
    const changes = {
      title: { before: 'a', after: 'b' },
      category: { before: 'normal' as const, after: 'abnormal' as const },
      status: { before: 'draft' as const, after: 'approved' as const },
    };
    const statusChange = { from: 'draft' as const, to: 'approved' as const };
    const entries = buildHistoryEntries({ changes, statusChange, actor: 'user:u1', now: 1000 });
    expect(entries[0]).toEqual({
      action: 'updated',
      delta: { title: { before: 'a', after: 'b' }, category: { before: 'normal', after: 'abnormal' } },
    });
    expect(entries[0]?.delta.status).toBeUndefined();
  });
});
