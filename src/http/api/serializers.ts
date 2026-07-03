// src/http/api/serializers.ts
// レスポンス JSON の共通シリアライザ(snake_case キー)。DB 行(camelCase)→ API 応答(snake_case)の
// 変換をここに一元化する。各エンドポイントは docs/apis/*.md で定義された固有のフィールド部分集合を
// 返す場合があるため、ここでは「その行が持ちうる全フィールド」を返す完全形として定義し、
// 呼び出し側(setup.ts/auth.ts 等)がドキュメントの契約に合わせて必要なフィールドのみを選び取る。
// 以後のタスク(ユーザー管理 API 等)がここにシリアライザを追記していく。
import type {
  UserRow, OrganizationRow, ProjectRow, ApiTokenRow, TestCaseRow, TestCaseHistoryRow,
  TestCaseIdentityRow, TestCaseObservationRow,
} from '../../storage/schema';
import { structuredDiff, type GwtP } from '../../domain/diff';

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

/** apis/testcases.md「GET /testcases/:id/identities」向け。ページングなしの単純な items 配列。 */
export function toIdentityJson(row: TestCaseIdentityRow) {
  return {
    id: row.id,
    origin: row.origin,
    external_ref: row.externalRef,
    is_stale: !!row.isStale,
    last_seen_at: row.lastSeenAt,
    created_at: row.createdAt,
  };
}

/**
 * apis/testcases.md「GET /testcases/:id/observations」向け。`observed`(JSON列)は文書化された
 * 6フィールド(given/when/then/parameters/source_ref/schema_version)のみを選び取る。
 *
 * GC-1 突合メモ: data-model.md「observed の固定キーセット」と schemas/sync.ts の `observedSchema`
 * (Task 1)は `title` も含む7キーだが、apis/testcases.md「GET /testcases/:id/observations」の
 * `observed` フィールド表には `title` が無い(6キー)。本関数は apis/testcases.md(本タスクの主参照
 * ドキュメント)のフィールド表どおり6キーに絞り、保存側に title が含まれていても応答からは落とす。
 * この食い違いはタスク報告に明示する。
 */
export function toObservationJson(row: TestCaseObservationRow) {
  const observed = JSON.parse(row.observed) as Record<string, unknown>;
  return {
    id: row.id,
    origin: row.origin,
    fingerprint: row.fingerprint,
    observed: {
      given: observed.given,
      when: observed.when,
      then: observed.then,
      parameters: observed.parameters,
      source_ref: observed.source_ref,
      schema_version: observed.schema_version,
    },
    created_at: row.createdAt,
  };
}

/**
 * apis/testcases.md「GET /testcases/:id/diff」向け。has_drift は testCase.drift をそのまま反映する
 * (再判定しない)。has_drift=false の場合、origin/observed_at/latest_observation/diff は常に null。
 * latestObservation が渡されない場合(観測が見つからない防御的なケース)は has_drift の値に関わらず
 * 同様に null で埋める(通常は drift=true のとき必ず観測が存在する前提。data-model.md「drift」)。
 */
export function toDiffJson(tc: TestCaseRow, latestObservation: TestCaseObservationRow | null) {
  const canonical = {
    given: tc.given,
    when: tc.when,
    then: tc.then,
    parameters: tc.parameters === null ? null : JSON.parse(tc.parameters),
  };
  const hasDrift = !!tc.drift;

  if (!hasDrift || !latestObservation) {
    return { has_drift: hasDrift, origin: null, observed_at: null, canonical, latest_observation: null, diff: null };
  }

  const observedRaw = JSON.parse(latestObservation.observed) as Record<string, unknown>;
  const latestObservationGwtp: GwtP = {
    given: observedRaw.given as string,
    when: observedRaw.when as string,
    then: observedRaw.then as string,
    parameters: (observedRaw.parameters ?? null) as GwtP['parameters'],
  };

  return {
    has_drift: true,
    origin: latestObservation.origin,
    observed_at: latestObservation.createdAt,
    canonical,
    latest_observation: latestObservationGwtp,
    diff: structuredDiff(canonical, latestObservationGwtp),
  };
}

/**
 * apis/testcases.md「POST /testcases/:id/accept-fingerprint」レスポンス向け(5フィールドの部分集合)。
 * updated_at の算出は toTestCaseJson と同じ D-05 の意味論を再利用する(重複させない)。
 */
export function toAcceptFingerprintJson(row: TestCaseRow) {
  const full = toTestCaseJson(row);
  return {
    id: full.id,
    fingerprint: full.fingerprint,
    drift: full.drift,
    version: full.version,
    updated_at: full.updated_at,
  };
}
