// src/storage/drizzle-storage.ts
import { and, eq, ne, isNull, count, desc, sql } from 'drizzle-orm';
import {
  organizations, users, sessions, projects, apiTokens, testCases, testCaseHistory,
  type SessionRow,
} from './schema';
import type {
  Storage, OrgScope, SetupParams, CreateUserParams,
  TestCaseFilters, Page, NewTestCaseColumns, NewHistoryEntry,
} from './interface';
import { encodeCursor, decodeCursor } from '../domain/cursor';

// 3アダプタの差(batch/transaction/raw)を吸収する薄いドライバ
export type AnyQuery = { run(): unknown };
export interface StorageDriver {
  db: any; // drizzle sqlite database(sync/async 両対応のため any。adapters 内でのみ生成)
  batch(queries: AnyQuery[]): Promise<void>;
  rawExec(sqlText: string): Promise<void>;
}
const uuid = () => crypto.randomUUID();

// 非同期ドライバ(libSQL/D1)は実エラーを DrizzleQueryError でラップし、元のメッセージは
// e.cause 側に退避される(better-sqlite3 は同期実行のため生のドライバエラーを直接投げる)。
// cause チェーンを辿ることで 3 アダプタ共通のポータブルな一意制約違反判定にする。
function isUniqueViolation(e: unknown): boolean {
  for (let err: unknown = e; err; err = (err as { cause?: unknown }).cause) {
    if (String((err as Error).message ?? err).includes('UNIQUE')) return true;
  }
  return false;
}

// task-13-brief.md「target は LIKE '%'||target||'%'(部分一致)。LIKE メタ文字(%_)はエスケープする」。
// バックスラッシュを先にエスケープしてから %/_ をエスケープする(順序を逆にすると二重エスケープになる)。
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// api-reference.md「カーソルベースページング」(タイブレーカー: (created_at, id) の安定ソート)。
// 不正なカーソル(decodeCursor が null を返す)は「先頭から」にフォールバックする(undefined を返す)。
function cursorPredicate(cursor: string | undefined, createdAtCol: any, idCol: any) {
  if (!cursor) return undefined;
  const decoded = decodeCursor(cursor);
  if (!decoded) return undefined;
  return sql`(${createdAtCol} < ${decoded.createdAt}) OR (${createdAtCol} = ${decoded.createdAt} AND ${idCol} < ${decoded.id})`;
}

export function createDrizzleStorage(driver: StorageDriver): Storage {
  const { db } = driver;

  const getUser: Storage['getUser'] = async (scope, id) => {
    const [u] = await db.select().from(users)
      .where(and(eq(users.id, id), eq(users.organizationId, scope.organizationId)));
    return u ?? null;
  };

  const getProject: Storage['getProject'] = async (scope, pid) => {
    const [p] = await db.select().from(projects)
      .where(and(eq(projects.id, pid), eq(projects.organizationId, scope.organizationId)));
    return p ?? null;
  };

  const storage = {
    async countOrganizations() {
      const [r] = await db.select({ n: count() }).from(organizations);
      return r?.n ?? 0;
    },
    async setupOrganization(p: SetupParams) {
      const org = { id: uuid(), name: p.orgName, createdAt: p.now, updatedAt: p.now };
      const user = {
        id: uuid(), organizationId: org.id, email: p.adminEmail, passwordHash: p.adminPasswordHash,
        displayName: p.adminDisplayName, role: 'admin', lastLoginAt: null, createdAt: p.now, updatedAt: p.now,
      };
      await driver.batch([db.insert(organizations).values(org), db.insert(users).values(user)]);
      return { organization: org, user } as any;
    },
    async findUserForLogin(email) {
      const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return u ?? null;
    },
    async getUserById(id) {
      const [u] = await db.select().from(users).where(eq(users.id, id));
      return u ?? null;
    },
    getUser,
    async listUsers(scope) {
      return db.select().from(users).where(eq(users.organizationId, scope.organizationId)).orderBy(users.createdAt);
    },
    async createUser(scope: OrgScope, p: CreateUserParams) {
      const row = {
        id: uuid(), organizationId: scope.organizationId, email: p.email, passwordHash: p.passwordHash,
        displayName: p.displayName, role: p.role, lastLoginAt: null, createdAt: p.now, updatedAt: p.now,
      };
      try {
        await db.insert(users).values(row).run();
      } catch (e: unknown) {
        if (isUniqueViolation(e)) return 'email_taken';
        throw e;
      }
      return row as any;
    },
    async updateUser(scope, id, patch, now) {
      await db.update(users)
        .set({ ...(patch.role ? { role: patch.role } : {}), ...(patch.displayName ? { displayName: patch.displayName } : {}), updatedAt: now })
        .where(and(eq(users.id, id), eq(users.organizationId, scope.organizationId))).run();
      return getUser(scope, id);
    },
    async setUserRoleGuarded(scope, id, newRole, now) {
      // D-13-7 の TOCTOU レース修正: admin 人数チェックを UPDATE の WHERE 句内に埋め込むことで、
      // 「読んでから書く」の2ラウンドトリップを単一の原子的な UPDATE に潰す(SQLite/D1/libSQL は
      // いずれも single-writer のため、この1文は他の書き込みと絶対にインターリーブしない)。
      // WHERE がマッチするのは (a) 新ロールが admin(昇格・ラテラルは無条件許可) (b) 対象が現在
      // admin でない(降格に該当しない) (c) 組織の admin 総数が2以上(対象を除いても1人以上残る)
      // のいずれか。3アダプタ共通のポータブルな subset(スカラー相関サブクエリ、LIMIT不使用)。
      await db.run(sql`
        UPDATE users
        SET role = ${newRole}, updated_at = ${now}
        WHERE id = ${id}
          AND organization_id = ${scope.organizationId}
          AND (
            ${newRole} = 'admin'
            OR role != 'admin'
            OR (
              SELECT COUNT(*) FROM users u2
              WHERE u2.organization_id = ${scope.organizationId} AND u2.role = 'admin'
            ) > 1
          )
      `);
      // drizzle の .run() 結果形は better-sqlite3(同期 .changes)/ D1(meta.changes)/ libSQL
      // (rowsAffected)で不揃い(このファイルの他メソッドも同様に統一アクセサへは依存していない。
      // 例: revokeApiToken は無条件 UPDATE 後に再SELECTして結果を判定する)。ここでも同じ流儀で、
      // UPDATE 後に再取得したロールが要求どおりかどうかで結果を判定する。
      const after = await getUser(scope, id);
      if (!after) return 'not_found';
      return after.role === newRole ? 'ok' : 'blocked_last_admin';
    },
    async countAdmins(scope) {
      const [r] = await db.select({ n: count() }).from(users)
        .where(and(eq(users.organizationId, scope.organizationId), eq(users.role, 'admin')));
      return r?.n ?? 0;
    },
    async setUserPassword(scope, userId, passwordHash, now) {
      await db.update(users).set({ passwordHash, updatedAt: now })
        .where(and(eq(users.id, userId), eq(users.organizationId, scope.organizationId))).run();
    },
    async touchLastLogin(scope, userId, now) {
      await db.update(users).set({ lastLoginAt: now })
        .where(and(eq(users.id, userId), eq(users.organizationId, scope.organizationId))).run();
    },
    async createSession(row: SessionRow) { await db.insert(sessions).values(row).run(); },
    async getSession(id) {
      const [s] = await db.select().from(sessions).where(eq(sessions.id, id));
      return s ?? null;
    },
    async deleteSession(id) { await db.delete(sessions).where(eq(sessions.id, id)).run(); },
    async deleteUserSessions(userId, exceptSessionId) {
      const cond = exceptSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
        : eq(sessions.userId, userId);
      await db.delete(sessions).where(cond).run();
    },
    async listProjects(scope) {
      const rows = await db
        .select({
          project: projects,
          testcaseCount: sql<number>`(SELECT COUNT(*) FROM ${testCases} tc WHERE tc.project_id = ${projects.id} AND tc.status != 'archived')`,
        })
        .from(projects).where(eq(projects.organizationId, scope.organizationId)).orderBy(projects.createdAt);
      return rows.map((r: any) => ({ ...r.project, testcaseCount: Number(r.testcaseCount) }));
    },
    getProject,
    async createProject(scope, p, now) {
      const row = { id: uuid(), organizationId: scope.organizationId, name: p.name, repoUrl: p.repoUrl ?? null, createdAt: now, updatedAt: now };
      await db.insert(projects).values(row).run();
      return row as any;
    },
    async updateProject(scope, pid, patch, now) {
      await db.update(projects)
        .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl } : {}), updatedAt: now })
        .where(and(eq(projects.id, pid), eq(projects.organizationId, scope.organizationId))).run();
      return getProject(scope, pid);
    },
    async createApiToken(scope, pid, name, tokenHash, now) {
      const row = { id: uuid(), projectId: pid, tokenHash, name, lastUsedAt: null, createdAt: now, revokedAt: null };
      await db.insert(apiTokens).values(row).run();
      return row as any;
    },
    async listApiTokens(scope, pid) {
      return db.select().from(apiTokens).where(eq(apiTokens.projectId, pid)).orderBy(apiTokens.createdAt);
    },
    async revokeApiToken(scope, pid, tokenId, now) {
      await db.update(apiTokens).set({ revokedAt: now })
        .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.projectId, pid), isNull(apiTokens.revokedAt))).run();
      const [row] = await db.select().from(apiTokens)
        .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.projectId, pid)));
      return row ?? null;
    },
    async findApiTokenByHash(tokenHash) {
      const [r] = await db
        .select({ token: apiTokens, organizationId: projects.organizationId })
        .from(apiTokens)
        .innerJoin(projects, eq(projects.id, apiTokens.projectId))
        .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)));
      return r ? { ...r.token, organizationId: r.organizationId } : null;
    },
    async touchTokenLastUsed(tokenId, now, thresholdMs) {
      await db.update(apiTokens).set({ lastUsedAt: now })
        .where(and(
          eq(apiTokens.id, tokenId),
          sql`(${apiTokens.lastUsedAt} IS NULL OR ${apiTokens.lastUsedAt} <= ${now - thresholdMs})`,
        )).run();
    },

    // --- test cases(task-13-brief.md)---
    async createTestCaseManual(scope: OrgScope, pid: string, row: NewTestCaseColumns, history: NewHistoryEntry, now: number) {
      const id = uuid();
      const tcRow = {
        id,
        projectId: pid,
        title: row.title,
        target: row.target,
        category: row.category,
        given: row.given,
        when: row.when,
        then: row.then,
        parameters: row.parameters === null ? null : JSON.stringify(row.parameters),
        status: row.status,
        isStale: 0,
        ownership: 'human',
        mirrorOrigin: null,
        drift: 0,
        fingerprint: null,
        version: 1,
        confidence: row.confidence,
        sourceRef: row.sourceRef === null ? null : JSON.stringify(row.sourceRef),
        createdOrigin: 'manual',
        metadata: row.metadata === null ? null : JSON.stringify(row.metadata),
        humanUpdatedAt: now,
        systemUpdatedAt: null,
        createdAt: now,
      };
      const historyRow = {
        id: uuid(),
        testCaseId: id,
        actor: history.actor,
        action: history.action,
        delta: JSON.stringify(history.delta),
        createdAt: now,
      };
      await driver.batch([db.insert(testCases).values(tcRow), db.insert(testCaseHistory).values(historyRow)]);
      return tcRow as any;
    },

    async getTestCase(scope: OrgScope, pid: string, id: string) {
      const [row] = await db.select().from(testCases)
        .where(and(eq(testCases.id, id), eq(testCases.projectId, pid)));
      return row ?? null;
    },

    async listTestCases(scope: OrgScope, pid: string, f: TestCaseFilters, page: Page) {
      const conditions = [eq(testCases.projectId, pid)];
      if (f.status) conditions.push(eq(testCases.status, f.status));
      if (f.category) conditions.push(eq(testCases.category, f.category));
      if (f.ownership) conditions.push(eq(testCases.ownership, f.ownership));
      if (f.drift !== undefined) conditions.push(eq(testCases.drift, f.drift ? 1 : 0));
      if (f.isStale !== undefined) conditions.push(eq(testCases.isStale, f.isStale ? 1 : 0));
      if (f.target !== undefined) {
        conditions.push(sql`${testCases.target} LIKE ${`%${escapeLike(f.target)}%`} ESCAPE '\\'`);
      }
      const whereBase = and(...conditions);

      const [totalRow] = await db.select({ n: count() }).from(testCases).where(whereBase);

      const cursorCond = cursorPredicate(page.cursor, testCases.createdAt, testCases.id);
      const whereFull = cursorCond ? and(whereBase, cursorCond) : whereBase;

      const rows = await db.select().from(testCases).where(whereFull)
        .orderBy(desc(testCases.createdAt), desc(testCases.id))
        .limit(page.limit + 1);

      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

      return { items, total: Number(totalRow?.n ?? 0), nextCursor, hasMore };
    },

    async listHistory(scope: OrgScope, pid: string, id: string, page: Page) {
      const whereBase = and(eq(testCaseHistory.testCaseId, id), eq(testCases.projectId, pid));

      const [totalRow] = await db.select({ n: count() })
        .from(testCaseHistory)
        .innerJoin(testCases, eq(testCases.id, testCaseHistory.testCaseId))
        .where(whereBase);

      const cursorCond = cursorPredicate(page.cursor, testCaseHistory.createdAt, testCaseHistory.id);
      const whereFull = cursorCond ? and(whereBase, cursorCond) : whereBase;

      // D-04: actor='user:<id>' → users.display_name、'token:<id>' → api_tokens.name、
      // どちらにも一致しなければ actor の生値(COALESCE のフォールバック)。
      const rows = await db.select({
        id: testCaseHistory.id,
        testCaseId: testCaseHistory.testCaseId,
        actor: testCaseHistory.actor,
        action: testCaseHistory.action,
        delta: testCaseHistory.delta,
        createdAt: testCaseHistory.createdAt,
        actorDisplay: sql<string>`COALESCE(${users.displayName}, ${apiTokens.name}, ${testCaseHistory.actor})`,
      })
        .from(testCaseHistory)
        .innerJoin(testCases, eq(testCases.id, testCaseHistory.testCaseId))
        .leftJoin(users, sql`${testCaseHistory.actor} = 'user:' || ${users.id}`)
        .leftJoin(apiTokens, sql`${testCaseHistory.actor} = 'token:' || ${apiTokens.id}`)
        .where(whereFull)
        .orderBy(desc(testCaseHistory.createdAt), desc(testCaseHistory.id))
        .limit(page.limit + 1);

      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

      return { items, total: Number(totalRow?.n ?? 0), nextCursor, hasMore };
    },
  } satisfies Storage;

  return storage;
}
