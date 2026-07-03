// src/http/api/serializers.ts
// レスポンス JSON の共通シリアライザ(snake_case キー)。DB 行(camelCase)→ API 応答(snake_case)の
// 変換をここに一元化する。各エンドポイントは docs/apis/*.md で定義された固有のフィールド部分集合を
// 返す場合があるため、ここでは「その行が持ちうる全フィールド」を返す完全形として定義し、
// 呼び出し側(setup.ts/auth.ts 等)がドキュメントの契約に合わせて必要なフィールドのみを選び取る。
// 以後のタスク(ユーザー管理 API 等)がここにシリアライザを追記していく。
import type { UserRow, OrganizationRow } from '../../storage/schema';

/** apis/users.md(Task 9以降)向けの完全形。last_login_at(D-05)を含む。 */
export function toUserJson(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    display_name: row.displayName,
    role: row.role,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_login_at: row.lastLoginAt,
  };
}

export function toOrganizationJson(row: OrganizationRow) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.createdAt,
  };
}
