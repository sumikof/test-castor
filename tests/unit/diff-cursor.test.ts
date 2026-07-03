// structuredDiff と cursor(encode/decode)のテスト。
// apis/testcases.md「GET /testcases/:id/diff」、api-reference.md「カーソルベースページング」を正本とする。
import { describe, it, expect } from 'vitest';
import { structuredDiff } from '../../src/domain/diff';
import { encodeCursor, decodeCursor } from '../../src/domain/cursor';

describe('structuredDiff', () => {
  const base = { given: 'g1', when: 'w1', then: 't1', parameters: null };

  it('given/then のみ差分 → 2キーのみ(when は含まれない)', () => {
    const canonical = { ...base };
    const observed = { ...base, given: 'g2', then: 't2' };
    expect(structuredDiff(canonical, observed)).toEqual({
      given: { before: 'g1', after: 'g2' },
      then: { before: 't1', after: 't2' },
    });
  });

  it('完全一致なら空オブジェクト', () => {
    expect(structuredDiff(base, { ...base })).toEqual({});
  });

  it('parameters が同一内容(順序同一)の JSON なら差分なし(別参照でも値が同じなら OK)', () => {
    const canonical = { ...base, parameters: [{ inputs: { a: 1 }, expected: 'x' }] };
    const observed = { ...base, parameters: [{ inputs: { a: 1 }, expected: 'x' }] };
    expect(structuredDiff(canonical, observed)).toEqual({});
  });

  it('parameters の内容が異なれば parameters キーに before/after が載る', () => {
    const canonical = { ...base, parameters: [{ inputs: { a: 1 }, expected: 'x' }] };
    const observed = { ...base, parameters: [{ inputs: { a: 2 }, expected: 'x' }] };
    expect(structuredDiff(canonical, observed).parameters).toEqual({
      before: [{ inputs: { a: 1 }, expected: 'x' }],
      after: [{ inputs: { a: 2 }, expected: 'x' }],
    });
  });

  it('parameters の配列要素順序が異なれば差分あり(順序も比較対象)', () => {
    const canonical = {
      ...base,
      parameters: [{ inputs: { a: 1 }, expected: 'x' }, { inputs: { a: 2 }, expected: 'y' }],
    };
    const observed = {
      ...base,
      parameters: [{ inputs: { a: 2 }, expected: 'y' }, { inputs: { a: 1 }, expected: 'x' }],
    };
    expect(structuredDiff(canonical, observed).parameters).toBeDefined();
  });

  it('parameters が両方 null なら差分なし', () => {
    expect(structuredDiff({ ...base, parameters: null }, { ...base, parameters: null })).toEqual({});
  });

  it('parameters が片方だけ null なら差分あり', () => {
    const canonical = { ...base, parameters: null };
    const observed = { ...base, parameters: [{ inputs: {}, expected: 'x' }] };
    expect(structuredDiff(canonical, observed).parameters).toEqual({ before: null, after: [{ inputs: {}, expected: 'x' }] });
  });

  it('parameters オブジェクトのキー順序違いは差分なし(JSON 値等価はキー順序を無視)', () => {
    const canonical = { ...base, parameters: [{ inputs: { a: 1, b: 2 }, expected: 'x' }] };
    const observed = { ...base, parameters: [{ expected: 'x', inputs: { b: 2, a: 1 } }] };
    expect(structuredDiff(canonical, observed)).toEqual({});
  });
});

describe('cursor: encodeCursor/decodeCursor', () => {
  it('encode → decode で往復し元の値に戻る', () => {
    const original = { createdAt: 1719388800000, id: 'uuid-123' };
    expect(decodeCursor(encodeCursor(original))).toEqual(original);
  });

  it('encode の結果は base64url 文字列(+/=を含まない)', () => {
    const encoded = encodeCursor({ createdAt: 1, id: 'x' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('不正な文字を含む base64 は null を返す', () => {
    expect(decodeCursor('not@@valid$$base64!!')).toBeNull();
  });

  it('長さが不正な base64(パディング崩れ)は null を返す', () => {
    expect(decodeCursor('A')).toBeNull();
  });

  it('base64 としては妥当だが JSON として不正な内容は null を返す(先頭からのフォールバック)', () => {
    const notJson = btoa('this is not json').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeCursor(notJson)).toBeNull();
  });

  it('base64+JSON としては妥当だが期待する形と異なる(createdAt欠落)場合は null を返す', () => {
    const wrongShape = btoa(JSON.stringify({ id: 'only-id' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeCursor(wrongShape)).toBeNull();
  });

  it('createdAt が数値でない場合は null を返す', () => {
    const wrongType = btoa(JSON.stringify({ created_at: 'not-a-number', id: 'x' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeCursor(wrongType)).toBeNull();
  });

  it('空文字列は null を返す', () => {
    expect(decodeCursor('')).toBeNull();
  });
});
