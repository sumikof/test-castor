// src/domain/diff.ts
// canonical(現在のテスト仕様)と観測(衛星の最新観測)の構造化差分。
// apis/testcases.md「GET /testcases/:id/diff」(given/when/then/parameters の4フィールド、
// parameters は JSON 等値比較、差分なしフィールドは含めない)を正本とする。

import type { FieldChange, ParamRow } from './testcase-rules';

export type GwtP = { given: string; when: string; then: string; parameters: ParamRow[] | null };

/** JSON 値としての深い等価性。キー順序は無視、配列要素順序は区別する(testcase-rules.ts と同一実装)。 */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;
  if (aIsArr && bIsArr) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).sort();
  const bKeys = Object.keys(bo).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => k === bKeys[i] && jsonDeepEqual(ao[k], bo[k]));
}

/**
 * given/when/then は文字列等価、parameters は JSON 値等価(配列要素順序は区別・オブジェクトキー順序は無視)で
 * 比較する。差分があるフィールドのみを返す(apis/testcases.md「差分なしのフィールドは diff に含まれない」)。
 */
export function structuredDiff(canonical: GwtP, observed: GwtP): Record<string, FieldChange> {
  const diff: Record<string, FieldChange> = {};
  if (canonical.given !== observed.given) diff.given = { before: canonical.given, after: observed.given };
  if (canonical.when !== observed.when) diff.when = { before: canonical.when, after: observed.when };
  if (canonical.then !== observed.then) diff.then = { before: canonical.then, after: observed.then };
  if (!jsonDeepEqual(canonical.parameters, observed.parameters)) {
    diff.parameters = { before: canonical.parameters, after: observed.parameters };
  }
  return diff;
}
