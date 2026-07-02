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
  testCaseId: text('test_case_id'), // 新規ケースは commit 工程で backfill(data-model)
  externalRef: text('external_ref').notNull(),
  projectId: text('project_id').notNull().references(() => projects.id),
  fingerprint: text('fingerprint').notNull(),
  observed: text('observed').notNull(), // JSON(固定キーセット)
  syncToken: text('sync_token').notNull(),
  origin: text('origin').notNull(),
  confidence: real('confidence'), // 実装ノート参照(docs 差分)
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
export type SyncStagingRow = typeof syncStaging.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type TestCaseHistoryRow = typeof testCaseHistory.$inferSelect;
