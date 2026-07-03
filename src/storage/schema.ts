import { sqliteTable, text, integer, real, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  displayName: text('display_name').notNull(),
  role: text('role').notNull(),
  lastLoginAt: integer('last_login_at'), // スペック D-05
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  uniqueIndex('uq_users_org_email').on(t.organizationId, t.email),
  check('ck_users_role', sql`${t.role} IN ('admin','editor','viewer')`),
]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('ix_sessions_user').on(t.userId)]);

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  repoUrl: text('repo_url'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const testCases = sqliteTable('test_cases', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  title: text('title').notNull(),
  target: text('target'),
  category: text('category').notNull(),
  given: text('given').notNull(),
  when: text('when').notNull(),
  then: text('then').notNull(),
  parameters: text('parameters'), // JSON 文字列
  status: text('status').notNull().default('draft'),
  isStale: integer('is_stale').notNull().default(0),
  ownership: text('ownership').notNull(),
  mirrorOrigin: text('mirror_origin'),
  drift: integer('drift').notNull().default(0),
  fingerprint: text('fingerprint'),
  version: integer('version').notNull().default(1),
  confidence: real('confidence'),
  sourceRef: text('source_ref'), // JSON
  createdOrigin: text('created_origin').notNull(),
  metadata: text('metadata'), // JSON
  humanUpdatedAt: integer('human_updated_at'),
  systemUpdatedAt: integer('system_updated_at'),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  index('ix_tc_project_status').on(t.projectId, t.status),
  index('ix_tc_project_category').on(t.projectId, t.category),
  index('ix_tc_project_stale').on(t.projectId, t.isStale),
  index('ix_tc_project_drift').on(t.projectId, t.drift),
  index('ix_tc_project_created').on(t.projectId, t.createdAt),
  check('ck_tc_status', sql`${t.status} IN ('draft','approved','archived')`),
  check('ck_tc_category', sql`${t.category} IN ('normal','abnormal','boundary','error_handling')`),
  check('ck_tc_ownership', sql`${t.ownership} IN ('machine','human')`),
  // status IN ('approved','archived') ⇒ ownership='human' の同値表現
  check('ck_tc_status_ownership', sql`${t.status} = 'draft' OR ${t.ownership} = 'human'`),
]);

export const testCaseIdentities = sqliteTable('test_case_identities', {
  id: text('id').primaryKey(),
  testCaseId: text('test_case_id').notNull().references(() => testCases.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  origin: text('origin').notNull(),
  externalRef: text('external_ref').notNull(),
  isStale: integer('is_stale').notNull().default(0),
  lastSeenSyncToken: text('last_seen_sync_token'),
  lastSeenAt: integer('last_seen_at'),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('uq_identity').on(t.projectId, t.origin, t.externalRef),
  index('ix_identity_lastseen').on(t.projectId, t.origin, t.lastSeenSyncToken),
  index('ix_identity_rollup').on(t.testCaseId, t.isStale, t.lastSeenAt),
]);

export const testCaseObservations = sqliteTable('test_case_observations', {
  id: text('id').primaryKey(),
  testCaseId: text('test_case_id').references(() => testCases.id), // 新規ケースは commit 工程で backfill(data-model)
  externalRef: text('external_ref').notNull(),
  projectId: text('project_id').notNull().references(() => projects.id),
  fingerprint: text('fingerprint').notNull(),
  observed: text('observed').notNull(), // JSON(固定キーセット)
  syncToken: text('sync_token').notNull(),
  origin: text('origin').notNull(),
  confidence: real('confidence'), // 実装ノート参照(docs 差分)
  // task-15-brief.md「もう1つの docs ギャップ」: observed 固定キーセットに category が無いが
  // test_cases.category は NOT NULL のため、observation のトップレベル任意フィールドとして追加。
  // confidence 列と同じ位置づけ(data-model.md/sync-protocol.md 未記載。Task 23 で docs 反映)。
  // 複数の書込経路を持つ test_cases.category と異なり、この列は syncAppendObservations の
  // 単一書込経路(Zod 検証済み入力のみ)のため CHECK 制約は付けず Zod のみで縛る(二重防御は省略)。
  category: text('category'),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('uq_obs_idem').on(t.externalRef, t.origin, t.syncToken, t.fingerprint),
  index('ix_obs_tc_time').on(t.testCaseId, t.createdAt),
  index('ix_obs_project_token').on(t.projectId, t.syncToken),
  index('ix_obs_ref_origin_time').on(t.projectId, t.origin, t.externalRef, t.createdAt),
]);

export const syncSessions = sqliteTable('sync_sessions', {
  token: text('token').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  origin: text('origin').notNull(),
  status: text('status').notNull().default('active'),
  startedAt: integer('started_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  committedAt: integer('committed_at'), // 以下4列はスペック D-01
  createdCount: integer('created_count'),
  changedCount: integer('changed_count'),
  staledCount: integer('staled_count'),
}, (t) => [
  uniqueIndex('uq_active_session').on(t.projectId, t.origin).where(sql`${t.status} = 'active'`),
  index('ix_sync_project_committed').on(t.projectId, t.status, t.committedAt),
  check('ck_sync_status', sql`${t.status} IN ('active','committed','expired')`),
]);

// task-15-brief.md「出現台帳」: chunk は変化点のみ観測を記録するため、変化なし ref は観測行が
// 作られない。commit 工程3/4(Task 16)の last_seen/stale 判定を観測ではなくこの台帳に向けることで、
// 「chunk 追記専用」「変化点のみ記録」「stale 正確性」の3不変条件を同時に満たす(⚠ 設計ノート参照)。
// data-model.md/sync-protocol.md 未記載の新テーブル(Task 23 で docs 反映予定)。sync_staging と同じく
// セッション寿命の作業データ(確定/失効後にパージ対象)のため PK は持たず一意索引のみで冪等性を担保する。
export const syncSeen = sqliteTable('sync_seen', {
  syncToken: text('sync_token').notNull().references(() => syncSessions.token),
  externalRef: text('external_ref').notNull(),
}, (t) => [uniqueIndex('uq_seen').on(t.syncToken, t.externalRef)]);

export const syncStaging = sqliteTable('sync_staging', {
  syncToken: text('sync_token').notNull().references(() => syncSessions.token),
  externalRef: text('external_ref').notNull(),
  newTestCaseId: text('new_test_case_id').notNull(),
}, (t) => [uniqueIndex('uq_staging').on(t.syncToken, t.externalRef)]);

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  tokenHash: text('token_hash').notNull(),
  name: text('name').notNull(),
  lastUsedAt: integer('last_used_at'),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
}, (t) => [uniqueIndex('uq_token_hash').on(t.tokenHash)]);

export const testCaseHistory = sqliteTable('test_case_history', {
  id: text('id').primaryKey(),
  testCaseId: text('test_case_id').notNull().references(() => testCases.id),
  actor: text('actor').notNull(), // 'user:<id>' | 'token:<id>'
  action: text('action').notNull(),
  delta: text('delta').notNull(), // JSON {field:{before,after}}
  createdAt: integer('created_at').notNull(),
}, (t) => [
  index('ix_history_tc_time').on(t.testCaseId, t.createdAt),
  // review round 1(sync commit の重複 imported 防止): test_case 1件につき action='imported' の履歴は
  // 厳密に1行という不変条件(sync-protocol.md 工程1)を DB 層でも強制する部分一意索引。JS 側の事前
  // チェック(drizzle-storage.ts の existingHistoryTcIds)だけでは、同一 token に対する2つの
  // syncCommitWindow 呼び出しが並行実行された場合に TOCTOU が生じ、重複 imported 行が挿入されうる
  // (tests/contract/occ-concurrency.test.ts の並行テストで再現)。uq_active_session と同じ手法
  // (部分一意索引 + onConflictDoNothing)で防ぐ。
  uniqueIndex('uq_history_imported_per_tc').on(t.testCaseId).where(sql`${t.action} = 'imported'`),
  check('ck_history_action', sql`${t.action} IN ('created','updated','status_changed','imported')`),
]);

export type OrganizationRow = typeof organizations.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type TestCaseRow = typeof testCases.$inferSelect;
export type TestCaseIdentityRow = typeof testCaseIdentities.$inferSelect;
export type TestCaseObservationRow = typeof testCaseObservations.$inferSelect;
export type SyncSessionRow = typeof syncSessions.$inferSelect;
export type SyncSeenRow = typeof syncSeen.$inferSelect;
export type SyncStagingRow = typeof syncStaging.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type TestCaseHistoryRow = typeof testCaseHistory.$inferSelect;
