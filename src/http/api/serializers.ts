// src/http/api/serializers.ts
// レスポンス JSON の共通シリアライザ(snake_case キー)。DB 行(camelCase)→ API 応答(snake_case)の
// 変換をここに一元化する。各エンドポイントは docs/apis/*.md で定義された固有のフィールド部分集合を
// 返す場合があるため、ここでは「その行が持ちうる全フィールド」を返す完全形として定義し、
// 呼び出し側(setup.ts/auth.ts 等)がドキュメントの契約に合わせて必要なフィールドのみを選び取る。
// 以後のタスク(ユーザー管理 API 等)がここにシリアライザを追記していく。
import type { UserRow, OrganizationRow, ProjectRow, ApiTokenRow, TestCaseRow, TestCaseHistoryRow } from '../../storage/schema';

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

/**
 * apis/projects.md 向け。`testcaseCount` を渡すと D-05 の `testcase_count` を含める。
 * GET /api/v1/projects の一覧アイテムは呼び出し側が testcaseCount を渡す。POST/PATCH レスポンスは
 * docs/apis/projects.md のフィールド表に testcase_count が無いため、呼び出し側は省略する。
 */
export function toProjectJson(row: ProjectRow, testcaseCount?: number) {
  return {
    id: row.id,
    name: row.name,
    repo_url: row.repoUrl,
    ...(testcaseCount !== undefined ? { testcase_count: testcaseCount } : {}),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function toOrganizationJson(row: OrganizationRow) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.createdAt,
  };
}

/**
 * apis/tokens.md GET一覧向け。`token_hash` は絶対に含めない(auth-security.md「平文の隔離」)ため、
 * ApiTokenRow を丸ごとスプレッドせず許可された5フィールドだけを明示的に選び取る。
 * 発行(POST)レスポンスは平文 `token` を含む別形状(この応答のみで1回返す)のため、ここでは扱わない
 * — tokens.ts の POST ハンドラが個別に組み立てる。
 */
export function toTokenJson(row: ApiTokenRow) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.createdAt,
    revoked_at: row.revokedAt,
    last_used_at: row.lastUsedAt,
  };
}

/**
 * apis/testcases.md「GET /testcases/:id」「POST /testcases」向けの全フィールド形(両者は同一構造)。
 * JSON 列(parameters/source_ref/metadata)を parse し、`updated_at` は D-05 の意味論
 * (`max(human_updated_at, system_updated_at, created_at)`。human_updated_at/system_updated_at は
 * どちらも null になり得るため 0 にフォールバックし、常に created_at 以上になることを保証する)で算出する。
 */
export function toTestCaseJson(row: TestCaseRow) {
  return {
    id: row.id,
    title: row.title,
    target: row.target,
    category: row.category,
    given: row.given,
    when: row.when,
    then: row.then,
    parameters: row.parameters === null ? null : JSON.parse(row.parameters),
    status: row.status,
    is_stale: !!row.isStale,
    ownership: row.ownership,
    mirror_origin: row.mirrorOrigin,
    drift: !!row.drift,
    fingerprint: row.fingerprint,
    version: row.version,
    confidence: row.confidence,
    source_ref: row.sourceRef === null ? null : JSON.parse(row.sourceRef),
    created_origin: row.createdOrigin,
    metadata: row.metadata === null ? null : JSON.parse(row.metadata),
    created_at: row.createdAt,
    updated_at: Math.max(row.humanUpdatedAt ?? 0, row.systemUpdatedAt ?? 0, row.createdAt),
  };
}

/**
 * apis/testcases.md「GET /testcases」一覧アイテムのフィールド表どおりのサブセット(11フィールド)。
 * toTestCaseJson() の完全形から選び取ることで updated_at(D-05)の算出ロジックを重複させない。
 */
export function toTestCaseListItemJson(row: TestCaseRow) {
  const full = toTestCaseJson(row);
  return {
    id: full.id,
    title: full.title,
    target: full.target,
    category: full.category,
    status: full.status,
    ownership: full.ownership,
    is_stale: full.is_stale,
    drift: full.drift,
    version: full.version,
    created_at: full.created_at,
    updated_at: full.updated_at,
  };
}

/**
 * apis/testcases.md「GET /testcases/:id/history」向け。delta(JSON列)を parse し、D-04 の
 * `actor_display` を追加する(ドキュメントのフィールド表には未記載だが、スペック D-04 が明記する
 * 非破壊な追加フィールド。global-constraints.md「スペックが優先」。タスク報告に doc 記載漏れを明示)。
 */
export function toHistoryJson(row: TestCaseHistoryRow & { actorDisplay: string }) {
  return {
    id: row.id,
    test_case_id: row.testCaseId,
    actor: row.actor,
    action: row.action,
    delta: JSON.parse(row.delta),
    created_at: row.createdAt,
    actor_display: row.actorDisplay,
  };
}
