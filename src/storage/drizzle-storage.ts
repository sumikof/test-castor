// src/storage/drizzle-storage.ts
import { and, eq, ne, isNull, count, sql } from 'drizzle-orm';
import {
  organizations, users, sessions, projects, apiTokens, testCases,
  type SessionRow,
} from './schema';
import type { Storage, OrgScope, SetupParams, CreateUserParams } from './interface';

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
  } satisfies Storage;

  return storage;
}
