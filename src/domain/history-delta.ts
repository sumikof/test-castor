// src/domain/history-delta.ts
// PATCH/bulk の結果(changes/statusChange)から TestCaseHistory への追記エントリを組み立てる純関数。
// data-model.md「TestCaseHistory」(追記専用・delta は変更フィールドのみの差分)、
// usecase.md UC-21「変更履歴の確認」(status_changed と updated が別エントリとして表示される)を正本とする。

import type { Status, HistoryAction } from '../schemas/enums';
import type { FieldChange } from './testcase-rules';

export type HistoryEntry = { action: HistoryAction; delta: Record<string, FieldChange> };

/**
 * changes/statusChange から追記すべき履歴エントリを組み立てる。
 *
 * - status を除く人間所有列に実変更があれば action='updated' の1エントリ(delta は status を除く変更のみ)。
 * - status の実変更があれば action='status_changed' の1エントリ(delta は {status:{before,after}} のみ)。
 * - 両方あれば2エントリ返す(UC-21 の例で status_changed と updated が別々の行として表示されることに対応)。
 *
 * 順序についての設計判断(UC-21 参照・ブリーフの選択肢のうち "updated を先" を採用):
 * UC-21 の例は「内容を編集する(14:25 updated)→ その後で承認する(14:30 status_changed)」という
 * 5分違いの別々の PATCH の例であり、単一 PATCH 内で両方が同時に起きるケースの順序を直接は示していない。
 * ただし表示は新しい順(status_changed が updated より上)であるため、本関数は
 * 「内容を編集し、その結果として状態を遷移させる」という業務上の自然な時系列
 * (UC-10/UC-11: レビュー・編集 → 承認)に合わせて配列の先頭に updated、末尾に status_changed を置く。
 * 呼び出し側(Task 14)が本配列の順で history 行を挿入し、一覧が
 * created_at 降順・同時刻は挿入順(rowid等)降順で tie-break する実装であれば、後から挿入される
 * status_changed が新しい順一覧の先頭に来るため、UC-21 の見え方とも整合する。
 *
 * actor/now は呼び出し側が history 行の actor/created_at を組み立てる際にそのまま使う値として
 * 受け取るが、本関数自身の action/delta の算出には使わない(ブリーフの戻り値型どおり {action,delta} のみ)。
 */
export function buildHistoryEntries(p: {
  changes: Record<string, FieldChange>;
  statusChange: { from: Status; to: Status } | null;
  actor: string;
  now: number;
}): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

  const fieldDelta: Record<string, FieldChange> = {};
  for (const [field, change] of Object.entries(p.changes)) {
    if (field === 'status') continue;
    fieldDelta[field] = change;
  }
  if (Object.keys(fieldDelta).length > 0) {
    entries.push({ action: 'updated', delta: fieldDelta });
  }

  if (p.statusChange) {
    entries.push({
      action: 'status_changed',
      delta: { status: { before: p.statusChange.from, after: p.statusChange.to } },
    });
  }

  return entries;
}
