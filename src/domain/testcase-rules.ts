// src/domain/testcase-rules.ts
// テストケースの状態機械・PATCH セマンティクス・一括操作の業務ルール(純関数のみ)。
// data-model.md「TestCase」「列の二分」「canonical 状態機械」「複合不変条件」、
// apis/testcases.md(PATCH 副作用・bulk 各アクションの業務ルール)を正本とする。
// Storage/HTTP/Auth への依存は一切持たない。TestCaseRow は型のみ(import type)で参照する
// (GC-6 ポータビリティ境界: @cloudflare/workers-types や D1 型は import しない)。

import type { Status, Category, BulkAction } from '../schemas/enums';
import type { TestCaseRow } from '../storage/schema';

/** data-model.md「列の二分」の人間所有列(commit 由来の書き込み不可侵・OCC version 管理対象)。 */
export const HUMAN_FIELDS = [
  'title',
  'target',
  'category',
  'given',
  'when',
  'then',
  'parameters',
  'status',
  'confidence',
  'metadata',
] as const;

export type FieldChange = { before: unknown; after: unknown };

/** parameters 列の1行。data-model.md「データ駆動テスト用 [{name?, inputs, expected}, ...]」。 */
export type ParamRow = { name?: string; inputs: unknown; expected: unknown };

/**
 * PATCH 入力(decode 済み値。parameters/metadata は JSON 文字列ではなく実体)。
 * HUMAN_FIELDS の10列のみを対象とする。
 *
 * 注記(GC-1 突合): Task 1 の Zod スキーマ `patchTestCaseInput`(src/schemas/api.ts)には
 * `source_ref` も PATCH 可能フィールドとして定義されているが、data-model.md「列の二分」の
 * 人間所有列の列挙(および本ブリーフの HUMAN_FIELDS 定数)には `source_ref` が含まれない。
 * そのため本関数は意図的に source_ref を扱わない(ownershipTransition/version bump の対象外)。
 * source_ref の PATCH 自体を禁止するものではないが、その適用は本関数の責務外(呼び出し側で
 * 別途カラム代入する)として切り離す。詳細はタスク報告を参照。
 */
export type PatchInput = {
  title?: string;
  target?: string | null;
  category?: Category;
  given?: string;
  when?: string;
  then?: string;
  parameters?: ParamRow[] | null;
  status?: Status;
  confidence?: number | null;
  metadata?: Record<string, unknown> | null;
};

/** JSON 値としての深い等価性。キー順序は無視、配列要素順序は区別する。 */
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
 * 状態遷移の許可マトリクス(data-model.md「状態遷移の許可マトリクス」)。
 *
 * | 遷移 | 許可 |
 * |---|---|
 * | draft → approved | ○ |
 * | draft → archived | ○ |
 * | approved → draft | ○ |
 * | approved → archived | ○ |
 * | archived → draft | ○ |
 * | archived → approved | ✕(復帰は必ず draft を経由する) |
 *
 * from === to(同値)は上記マトリクスに明示されていないが no-op として常に許可する。
 */
export function canTransition(from: Status, to: Status): boolean {
  if (from === to) return true;
  switch (from) {
    case 'draft':
      return to === 'approved' || to === 'archived';
    case 'approved':
      return to === 'draft' || to === 'archived';
    case 'archived':
      return to === 'draft';
    default:
      return false;
  }
}

type ComputeHumanPatchResult =
  | {
      ok: true;
      changes: Record<string, FieldChange>;
      columnValues: Record<string, unknown>;
      ownershipTransition: boolean;
      statusChange: { from: Status; to: Status } | null;
    }
  | { ok: false; error: 'invalid_transition' };

/**
 * PATCH セマンティクス(api-reference.md「PATCH セマンティクス」: キー未指定=不変/明示的null=クリア)を
 * 適用し、実際に値が変わった人間所有列のみを changes/columnValues に反映する。
 *
 * - status の遷移が状態遷移マトリクスに違反する場合は他フィールドの変更も含め全体を拒否する
 *   (アトミック: invalid_transition の場合、changes/columnValues は一切計算しない)。
 * - ownershipTransition: current.ownership==='machine' かつ changes が1つ以上のとき true
 *   (data-model.md「machine→human は不可逆。人間の最初の値が実際に変化した人間所有列のPATCHで遷移」
 *   「同値PATCH(no-op)では遷移しない」)。status のみの変更(UC-11: 編集せず承認)でも、
 *   status 自体が人間所有列であるため changes に載り、ownershipTransition の対象になる。
 * - changes が1つ以上のとき version を+1する(data-model.md「version は人間所有列の更新時のみ+1」)。
 *   human_updated_at は clock 注入が必要(GC-3)なため本関数の範囲外とし、呼び出し側(Task 13/14)が
 *   自前の now を用いて設定する。
 */
export function computeHumanPatch(current: TestCaseRow, patch: PatchInput): ComputeHumanPatchResult {
  const currentStatus = current.status as Status;

  if (patch.status !== undefined && !canTransition(currentStatus, patch.status)) {
    return { ok: false, error: 'invalid_transition' };
  }

  const changes: Record<string, FieldChange> = {};
  const columnValues: Record<string, unknown> = {};

  const record = (field: (typeof HUMAN_FIELDS)[number], before: unknown, after: unknown, columnValue: unknown) => {
    if (jsonDeepEqual(before, after)) return;
    changes[field] = { before, after };
    columnValues[field] = columnValue;
  };

  if (patch.title !== undefined) record('title', current.title, patch.title, patch.title);
  if (patch.target !== undefined) record('target', current.target, patch.target, patch.target);
  if (patch.category !== undefined) record('category', current.category, patch.category, patch.category);
  if (patch.given !== undefined) record('given', current.given, patch.given, patch.given);
  if (patch.when !== undefined) record('when', current.when, patch.when, patch.when);
  if (patch.then !== undefined) record('then', current.then, patch.then, patch.then);
  if (patch.confidence !== undefined) record('confidence', current.confidence, patch.confidence, patch.confidence);

  if (patch.parameters !== undefined) {
    const before = current.parameters === null ? null : (JSON.parse(current.parameters) as unknown);
    const columnValue = patch.parameters === null ? null : JSON.stringify(patch.parameters);
    record('parameters', before, patch.parameters, columnValue);
  }

  if (patch.metadata !== undefined) {
    const before = current.metadata === null ? null : (JSON.parse(current.metadata) as unknown);
    const columnValue = patch.metadata === null ? null : JSON.stringify(patch.metadata);
    record('metadata', before, patch.metadata, columnValue);
  }

  if (patch.status !== undefined) record('status', currentStatus, patch.status, patch.status);

  const statusChange: { from: Status; to: Status } | null =
    patch.status !== undefined && patch.status !== currentStatus ? { from: currentStatus, to: patch.status } : null;

  const ownershipTransition = current.ownership === 'machine' && Object.keys(changes).length > 0;

  if (Object.keys(changes).length > 0) {
    columnValues.version = current.version + 1;
    if (ownershipTransition) columnValues.ownership = 'human';
  }

  return { ok: true, changes, columnValues, ownershipTransition, statusChange };
}

type BulkActionResult =
  | { kind: 'update'; newStatus: Status; ownershipTransition: boolean }
  | { kind: 'skip' }
  | { kind: 'error'; code: 'VALIDATION_FAILED'; message: string };

/**
 * bulk 操作(apis/testcases.md「POST /testcases/bulk」副作用・業務ルール)。
 *
 * - approve: draft→approved(machine 所有なら human へ不可逆遷移。ownershipTransition は
 *   row.ownership==='machine' と同値)。approved は既に対象ステータスのため skip。
 *   archived は VALIDATION_FAILED(「archived のテストケースには approve を実行できない。
 *   restore で draft に復帰してから承認する」)。
 * - archive: archived 以外(draft/approved)→archived。DB CHECK 制約
 *   `status IN ('approved','archived') ⇒ ownership='human'`(複合不変条件)により、
 *   machine 所有の draft を archive する場合も human への遷移を伴わなければ制約違反になる
 *   ため ownershipTransition=true にする(approved はこの不変条件により常に既に human 所有=
 *   到達不能な approved+machine は無いので、この式は approved からの archive では自然に false)。
 *   archived は既に対象ステータスのため skip。
 * - restore: archived→draft。archived は複合不変条件により常に ownership='human' 済みなので
 *   ownershipTransition は常に false。archived 以外(draft/approved)は「archived 以外はスキップ」
 *   (apis/testcases.md)によりすべて skip。
 */
export function applyBulkAction(row: TestCaseRow, action: BulkAction): BulkActionResult {
  const status = row.status as Status;
  const ownershipTransition = row.ownership === 'machine';

  if (action === 'approve') {
    if (status === 'draft') return { kind: 'update', newStatus: 'approved', ownershipTransition };
    if (status === 'approved') return { kind: 'skip' };
    return { kind: 'error', code: 'VALIDATION_FAILED', message: 'cannot approve an archived test case' };
  }

  if (action === 'archive') {
    if (status === 'archived') return { kind: 'skip' };
    return { kind: 'update', newStatus: 'archived', ownershipTransition };
  }

  // restore
  if (status === 'archived') return { kind: 'update', newStatus: 'draft', ownershipTransition: false };
  return { kind: 'skip' };
}
