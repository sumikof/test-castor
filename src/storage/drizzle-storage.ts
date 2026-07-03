// src/storage/drizzle-storage.ts
import { and, eq, ne, isNull, count, desc, sql, inArray } from 'drizzle-orm';
import {
  organizations, users, sessions, projects, apiTokens, testCases, testCaseHistory,
  testCaseIdentities, testCaseObservations, syncSessions, syncSeen,
  type SessionRow, type TestCaseRow, type SyncSessionRow,
} from './schema';
import type {
  Storage, OrgScope, SetupParams, CreateUserParams,
  TestCaseFilters, Page, NewTestCaseColumns, NewHistoryEntry, ChunkObservation,
} from './interface';
import { encodeCursor, decodeCursor } from '../domain/cursor';
import { applyBulkAction } from '../domain/testcase-rules';
import { buildHistoryEntries } from '../domain/history-delta';
import type { Status } from '../schemas/enums';

// 3アダプタの差(batch/transaction/raw)を吸収する薄いドライバ
export type AnyQuery = { run(): unknown };
export interface StorageDriver {
  db: any; // drizzle sqlite database(sync/async 両対応のため any。adapters 内でのみ生成)
  /**
   * 複数の書き込み文を単一トランザクションとして原子的に実行し、各文が実際に影響した行数を
   * 実行順の配列で返す(better-sqlite3: RunResult.changes / D1: D1Result.meta.changes / libSQL:
   * ResultSet.rowsAffected。3アダプタとも SQLite の `changes()` 相当のセマンティクス)。
   * review round 1(CRITICAL OCC concurrency)以前は Promise<void> で戻り値を捨てていたため、
   * OCC 対象の UPDATE が実際に0行しか更新しなくても呼び出し側が気づけず、対になる history INSERT が
   * 無条件に走って「偽の成功 + phantom history」を生む欠陥があった(drizzle-storage.ts の
   * patchTestCase/acceptFingerprint/archiveTestCase 参照)。戻り値を検査することで、事前チェックの
   * スナップショットではなく「実際に何が書けたか」を根拠に conflict/ok を判定できるようにする。
   */
  batch(queries: AnyQuery[]): Promise<number[]>;
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

// task-15-brief.md「D1 制約: 1 INSERT 文あたり ≤16 行(bind パラメータ上限)」。sync_seen/observation の
// 複数行 INSERT を分割するための汎用ヘルパ(3アダプタ共通)。
//
// 実装ノート(brief の「16」との差分・タスク報告に明記): sync-protocol.md の実際の制約は
// 「1文あたり bind ≤ 100」で、「chunk は ≤16行/文」はその帰結(1行あたり ~6列を想定した目安値)。
// test_case_observations は id/test_case_id/external_ref/project_id/fingerprint/observed/sync_token/
// origin/confidence/category/created_at の11列を1行ごとにフルバインドするため、16行だと176 bind と
// なり ≤100 制約を超える(D1(miniflare)契約テストで実測: 16行×11列の INSERT で
// "too many SQL variables" が発生することを確認済み)。そのため観測 INSERT は列数から逆算した
// 8行/文(88 bind ≤ 100)に、sync_seen(sync_token, external_ref の2列のみ)は brief どおり16行/文
// (32 bind)にする。
const OBSERVATION_BATCH_ROWS = 8;
const SEEN_BATCH_ROWS = 16;
function toBatches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

  // task-14-brief.md「patchTestCase/archiveTestCase/acceptFingerprint」から再利用するため、
  // getUser/getProject と同じ流儀で先出しする(以後の書き込み系メソッドが自己完結できるように)。
  const getTestCase: Storage['getTestCase'] = async (scope, pid, id) => {
    const [row] = await db.select().from(testCases)
      .where(and(eq(testCases.id, id), eq(testCases.projectId, pid)));
    return row ?? null;
  };

  // data-model.md「drift」の基準列: mirror_origin 由来・committed セッションの最新観測。
  // mirror_origin が null(手動作成)の行は origin = NULL の等価比較が常に unknown になるため
  // 自然に「該当なし」になる(追加の null ガードは不要)。
  const getLatestCommittedObservation: Storage['getLatestCommittedObservation'] = async (scope, pid, id) => {
    const [row] = await db
      .select({ obs: testCaseObservations })
      .from(testCaseObservations)
      .innerJoin(testCases, eq(testCases.id, testCaseObservations.testCaseId))
      .innerJoin(syncSessions, eq(syncSessions.token, testCaseObservations.syncToken))
      .where(and(
        eq(testCaseObservations.testCaseId, id),
        eq(testCaseObservations.projectId, pid),
        eq(syncSessions.status, 'committed'),
        eq(testCaseObservations.origin, testCases.mirrorOrigin),
      ))
      .orderBy(desc(testCaseObservations.createdAt), desc(testCaseObservations.id))
      .limit(1);
    return row ? row.obs : null;
  };

  // review round 1(CRITICAL OCC concurrency)。TestCaseHistory への「条件付き」INSERT を組み立てる。
  // 直前に同一 batch(=同一トランザクション・同一コネクション)内で完了した UPDATE の affected 行数を
  // SQLite組み込み関数 `changes()` で読み、1以上のときのみ実際に1行 INSERT する
  // (`INSERT INTO ... SELECT <値> WHERE (SELECT changes()) > 0`。FROM を伴わない SELECT は
  // WHERE が偽なら0行を返す標準 SQL で、3アダプタ(better-sqlite3/D1/libSQL)とも動作する)。
  // `changes()` は「直前に完了した INSERT/UPDATE/DELETE」を指し、SELECT では更新されないため、
  // このガード自身が実行されても(0行 INSERT でも)次に連鎖するガード付き INSERT へ同じ0/1の
  // シグナルを正しく伝播する(historyEntries が複数件でもチェーンとして機能する)。
  // driver.batch の戻り値(affected行数の検査)と独立した DB 側の二重防御(belt-and-suspenders)であり、
  // 万一 TS 側の count 検査を書き漏らしても phantom history だけは構造的に防げる。
  const guardedHistoryInsert = (h: NewHistoryEntry, testCaseId: string, now: number) =>
    db.insert(testCaseHistory).select(
      sql`SELECT ${uuid()}, ${testCaseId}, ${h.actor}, ${h.action}, ${JSON.stringify(h.delta)}, ${now} WHERE (SELECT changes()) > 0`,
    );

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

    getTestCase,

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

    // --- test cases 書き込み系(task-14-brief.md)---
    // review round 1(CRITICAL OCC concurrency)。旧実装は事前チェック(current.version !==
    // p.expectedVersion)だけで conflict を決めていた。これは「2つのリクエストが両方とも同じ
    // version(例: 5)を読んでから競走する」真の並行レースを検出できない: 敗者側の事前チェックも
    // (勝者の書き込みがまだ確定していない時点では)自分の expectedVersion と一致してしまうため、
    // この早期判定をすり抜けて次段の UPDATE に到達する。DB 側では single-writer により2つの batch が
    // 直列化され、先着した UPDATE が version を+1し、後着した UPDATE の WHERE version=:expected は
    // 0行にしか一致しない(エラーにはならない)。旧実装はこの affected 行数を検査せず、対になる
    // history INSERT を無条件に実行し、`{...current, ...setValues}` で組み立てた「捏造」行を伴う
    // {kind:'ok'} を返していた ⇒ 敗者クライアントに false 200 + ETag、TestCaseHistory に phantom entry。
    //
    // 修正: 事前チェック(getTestCase)の役割を「id が存在するか(404)」だけに縮小し、conflict の判定は
    // 「UPDATE の WHERE version=:expected が実際に何行へ命中したか」(driver.batch の返す affected 行数)
    // のみを根拠にする(事前チェックのスナップショットは一切信用しない)。version/ownership も
    // p.columnValues のアプリ側スナップショット値(computeHumanPatch が current.version+1 等から算出した
    // もの)ではなく、UPDATE 文内で現在行を基準に SQL 側で導出する(version=version+1 / CASE式)。
    // history INSERT は guardedHistoryInsert により `changes()>0` でガードし、0行更新(conflict)時に
    // history だけが増える phantom entry を DB 側でも二重に防ぐ。
    async patchTestCase(scope: OrgScope, pid: string, id: string, p) {
      const current = await getTestCase(scope, pid, id);
      if (!current) return { kind: 'not_found' as const };

      // p.columnValues は domain.computeHumanPatch が事前スナップショットから計算した version/ownership を
      // 含みうるが、上記のとおりここでは使わない(SQL 側で現在行基準に導出するため除外する)。
      const { version: _snapshotVersion, ownership: _snapshotOwnership, ...restColumnValues } = p.columnValues;
      const setValues: Record<string, unknown> = {
        ...restColumnValues,
        humanUpdatedAt: p.now,
        version: sql`${testCases.version} + 1`,
      };
      if (p.ownershipTransition) {
        setValues.ownership = sql`CASE WHEN ${testCases.ownership} = 'machine' THEN 'human' ELSE ${testCases.ownership} END`;
      }

      // WHERE version=:expected が OCC の唯一の判定点(belt-and-suspenders ではなく本判定)。
      const statements: AnyQuery[] = [
        db.update(testCases).set(setValues as any)
          .where(and(eq(testCases.id, id), eq(testCases.projectId, pid), eq(testCases.version, p.expectedVersion))),
        ...p.historyEntries.map((h) => guardedHistoryInsert(h, id, p.now)),
      ];
      const counts = await driver.batch(statements);
      const updateCount = counts[0] ?? 0;
      if (updateCount === 0) return { kind: 'conflict' as const };

      // updateCount>=1 は UPDATE が実際に着地したことの証明(=行は存在する)。SQL 側で導出した
      // version/ownership を含め、実際に書き込まれた値を正として再取得する(アプリ側再構築に頼らない)。
      const row = await getTestCase(scope, pid, id);
      if (!row) throw new Error('patchTestCase: row unexpectedly missing after a successful update');
      return { kind: 'ok' as const, row };
    },

    // review round 1(CRITICAL OCC concurrency)。旧実装は WHERE に version 条件を含めない(D-02 どおり
    // OCC 不要)一方、SET する version/ownership を事前チェックのスナップショット(current.version+1 /
    // current.ownership)からアプリ側で計算していた。これは「事前チェックと UPDATE の間に別の書き込み
    // (例: 並行する patchTestCase)が着地する」レースで、その並行更新の version/ownership を古い値で
    // 上書き(回帰)しうる欠陥だった。修正: version/ownership は UPDATE 文内で現在行を基準に SQL 側で
    // 導出する(version=version+1 / CASE式)ため、事前チェックと UPDATE の間に何が起きていても
    // 「現在の値+1」「現在の ownership から派生した値」に必ずなる。
    // 加えて WHERE に `status != 'archived'` を埋め込み、2つの同時 archive リクエストが両方とも
    // 「まだ archived ではない」を読んでから競走しても、先着した側だけが実際に status を変更し
    // (後着の UPDATE は0行に短絡)、guardedHistoryInsert の changes()>0 ガードにより後着側の
    // history だけが phantom で増えることも防ぐ(冪等)。D-02: OCC(version 条件)は使わず、
    // 常に成功として現在値を返す(never 409)。
    async archiveTestCase(scope: OrgScope, pid: string, id: string, actor: string, now: number) {
      const current = await getTestCase(scope, pid, id);
      if (!current) return null;
      if (current.status === 'archived') return current; // 冪等: 既に archived なら現状をそのまま返す(書き込みを試みない)

      const historyRow: NewHistoryEntry = {
        actor, action: 'status_changed',
        delta: { status: { before: current.status, after: 'archived' } },
      };
      await driver.batch([
        db.update(testCases).set({
          status: 'archived',
          version: sql`${testCases.version} + 1`,
          // 複合不変条件 status IN ('approved','archived') ⇒ ownership='human' を満たすため、
          // machine 所有の draft を archive する場合も human へ遷移させる(data-model.md)。
          ownership: sql`CASE WHEN ${testCases.ownership} = 'machine' THEN 'human' ELSE ${testCases.ownership} END`,
          humanUpdatedAt: now,
        }).where(and(eq(testCases.id, id), eq(testCases.projectId, pid), ne(testCases.status, 'archived'))),
        guardedHistoryInsert(historyRow, id, now),
      ]);

      // affected 行数は分岐に使わない(常に成功として扱う。D-02: never 409)。0行(競合する同時 archive に
      // 敗れた)でも「archived に到達済み」という望んだ終状態は変わらないため、現在値を再取得して返す。
      // 行は事前チェックで存在確認済みであり、テストケースに物理 DELETE は存在しないため null にはならない。
      const row = await getTestCase(scope, pid, id);
      if (!row) throw new Error('archiveTestCase: row unexpectedly missing after guarded update');
      return row;
    },

    async bulkAction(scope: OrgScope, pid: string, ids: string[], action, actor: string, now: number) {
      // OCC は使用しない(apis/testcases.md「一括操作の利便性を優先」)。SELECT → domain 判定 → batch。
      // ids の重複は1回分として扱う(同一行に対する UPDATE/history の二重計上・二重付与を防ぐ)。
      const uniqueIds = [...new Set(ids)];
      const rows: TestCaseRow[] = uniqueIds.length > 0
        ? await db.select().from(testCases).where(and(eq(testCases.projectId, pid), inArray(testCases.id, uniqueIds)))
        : [];
      const rowsById = new Map(rows.map((r) => [r.id, r]));

      let updated = 0;
      let skipped = 0;
      const errors: Array<{ id: string; code: string; message: string }> = [];
      const statements: any[] = [];

      for (const id of uniqueIds) {
        const row = rowsById.get(id);
        if (!row) {
          errors.push({ id, code: 'NOT_FOUND', message: 'test case not found' });
          continue;
        }
        const decision = applyBulkAction(row, action);
        if (decision.kind === 'skip') { skipped++; continue; }
        if (decision.kind === 'error') { errors.push({ id, code: decision.code, message: decision.message }); continue; }

        const setValues: Record<string, unknown> = { status: decision.newStatus, version: row.version + 1, humanUpdatedAt: now };
        if (decision.ownershipTransition) setValues.ownership = 'human';
        statements.push(db.update(testCases).set(setValues as any).where(and(eq(testCases.id, id), eq(testCases.projectId, pid))));

        const entries = buildHistoryEntries({
          changes: {}, statusChange: { from: row.status as Status, to: decision.newStatus }, actor, now,
        });
        for (const e of entries) {
          statements.push(db.insert(testCaseHistory).values({
            id: uuid(), testCaseId: id, actor, action: e.action, delta: JSON.stringify(e.delta), createdAt: now,
          }));
        }
        updated++;
      }

      if (statements.length > 0) await driver.batch(statements);
      return { updated, skipped, errors };
    },

    // review round 1(CRITICAL OCC concurrency)。patchTestCase と同じ理由・同じ修正パターン
    // (コメント詳細は patchTestCase 参照): conflict の判定は事前チェックのスナップショット比較ではなく
    // 「UPDATE の WHERE version=:expected が実際に何行へ命中したか」のみを根拠にする。
    async acceptFingerprint(scope: OrgScope, pid: string, id: string, expectedVersion: number, actor: string, now: number) {
      const current = await getTestCase(scope, pid, id);
      if (!current) return { kind: 'not_found' as const };
      // drift 判定は OCC より先に行う(no_drift は前提条件違反であり version の一致・不一致を問わない。
      // ここは事前チェックのままでよい: version とは独立した業務ルール上の前提条件であり、
      // OCC のすり抜けとは無関係)。
      if (!current.drift) return { kind: 'no_drift' as const };

      const latest = await getLatestCommittedObservation(scope, pid, id);
      const newFingerprint = latest ? latest.fingerprint : current.fingerprint;

      // version は expectedVersion+1(アプリ側スナップショット)ではなく SQL 側で現在行を基準に導出する
      // (version=version+1)。WHERE version=:expected が OCC の唯一の判定点(本判定)。
      const historyRow: NewHistoryEntry = {
        actor, action: 'status_changed',
        delta: { drift: { before: true, after: false }, fingerprint: { before: current.fingerprint, after: newFingerprint } },
      };
      const statements: AnyQuery[] = [
        db.update(testCases).set({
          fingerprint: newFingerprint,
          drift: 0,
          version: sql`${testCases.version} + 1`,
          humanUpdatedAt: now,
        }).where(and(eq(testCases.id, id), eq(testCases.projectId, pid), eq(testCases.version, expectedVersion))),
        guardedHistoryInsert(historyRow, id, now),
      ];
      const counts = await driver.batch(statements);
      const updateCount = counts[0] ?? 0;
      if (updateCount === 0) return { kind: 'conflict' as const };

      const row = await getTestCase(scope, pid, id);
      if (!row) throw new Error('acceptFingerprint: row unexpectedly missing after a successful update');
      return { kind: 'ok' as const, row };
    },

    async listIdentities(scope: OrgScope, pid: string, id: string) {
      return db.select().from(testCaseIdentities)
        .where(and(eq(testCaseIdentities.testCaseId, id), eq(testCaseIdentities.projectId, pid)))
        .orderBy(testCaseIdentities.createdAt, testCaseIdentities.id);
    },

    async listObservations(scope: OrgScope, pid: string, id: string, p) {
      // committed セッション由来のみ(data-model.md「意味論的隔離」)。origin は任意フィルタ。
      const conditions = [
        eq(testCaseObservations.testCaseId, id),
        eq(testCaseObservations.projectId, pid),
        eq(syncSessions.status, 'committed'),
      ];
      if (p.origin) conditions.push(eq(testCaseObservations.origin, p.origin));
      const whereBase = and(...conditions);

      const [totalRow] = await db.select({ n: count() })
        .from(testCaseObservations)
        .innerJoin(syncSessions, eq(syncSessions.token, testCaseObservations.syncToken))
        .where(whereBase);

      const cursorCond = cursorPredicate(p.cursor, testCaseObservations.createdAt, testCaseObservations.id);
      const whereFull = cursorCond ? and(whereBase, cursorCond) : whereBase;

      const rows = await db.select({ obs: testCaseObservations })
        .from(testCaseObservations)
        .innerJoin(syncSessions, eq(syncSessions.token, testCaseObservations.syncToken))
        .where(whereFull)
        .orderBy(desc(testCaseObservations.createdAt), desc(testCaseObservations.id))
        .limit(p.limit + 1);

      const allItems = rows.map((r: any) => r.obs);
      const hasMore = allItems.length > p.limit;
      const items = hasMore ? allItems.slice(0, p.limit) : allItems;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

      return { items, total: Number(totalRow?.n ?? 0), nextCursor, hasMore };
    },

    getLatestCommittedObservation,

    // --- sync(task-15-brief.md。start/chunk の前半のみ。commit(工程0-8)は Task 16)---

    // sync-protocol.md「失効の執行モデル(プライマリ: 遅延評価)」。syncStart 自身はこれを呼ばず、
    // 同じ述語の UPDATE を自身の batch に inline する(下記 syncStart 参照。INSERT と同一トランザクション
    // にする必要があるため独立実装にしている)。
    async syncExpireLapsed(scope: OrgScope, pid: string, origin: string | null, now: number) {
      const conditions = [
        eq(syncSessions.projectId, pid),
        eq(syncSessions.status, 'active'),
        sql`${syncSessions.expiresAt} <= ${now}`,
      ];
      if (origin !== null) conditions.push(eq(syncSessions.origin, origin));
      await db.update(syncSessions).set({ status: 'expired' }).where(and(...conditions)).run();
    },

    // sync-protocol.md「POST /sync/start」「実装は batch([期限切れ active→expired UPDATE, 新規 active
    // INSERT])を1トランザクションで実行」。UPDATE を先に置くことで、genuinely 期限切れの旧セッションが
    // 同一 origin に残っていても INSERT 前に expired へ倒れ、部分一意索引 uq_active_session に衝突しない
    // (真に有効な active が残っている場合のみ、後続の INSERT がその索引違反で conflict になる)。
    async syncStart(scope: OrgScope, pid: string, p: { token: string; origin: string; now: number; slidingMs: number }) {
      const row = {
        token: p.token,
        projectId: pid,
        origin: p.origin,
        status: 'active',
        startedAt: p.now,
        expiresAt: p.now + p.slidingMs,
        committedAt: null,
        createdCount: null,
        changedCount: null,
        staledCount: null,
      };
      try {
        await driver.batch([
          db.update(syncSessions).set({ status: 'expired' }).where(and(
            eq(syncSessions.projectId, pid),
            eq(syncSessions.origin, p.origin),
            eq(syncSessions.status, 'active'),
            sql`${syncSessions.expiresAt} <= ${p.now}`,
          )),
          db.insert(syncSessions).values(row),
        ]);
      } catch (e) {
        if (isUniqueViolation(e)) return { kind: 'conflict' as const };
        throw e;
      }
      return { kind: 'created' as const, session: row as SyncSessionRow };
    },

    async syncGetSession(scope: OrgScope, pid: string, token: string) {
      const [row] = await db.select().from(syncSessions)
        .where(and(eq(syncSessions.token, token), eq(syncSessions.projectId, pid)));
      return row ?? null;
    },

    // touchTokenLastUsed と同じ規約(GC-5 の追加の例外): token は認証済み・存在確認済みの PK のため
    // scope 引数を取らない。
    async syncTouchExpiry(token: string, expiresAt: number) {
      await db.update(syncSessions).set({ expiresAt }).where(eq(syncSessions.token, token)).run();
    },

    // sync-protocol.md「変化点のみ記録」+ task-15-brief.md「出現台帳」設計ノート(⚠ 設計上の重要ノート)。
    async syncAppendObservations(scope: OrgScope, pid: string, session: SyncSessionRow, obs: ChunkObservation[], now: number) {
      if (obs.length === 0) return [];
      const refs = [...new Set(obs.map((o) => o.externalRef))];

      // ① committed-JOIN フェンス(sync-protocol.md「committed-JOIN フェンス」): committed セッション由来
      // または当セッション自身の観測のみを対象に、ref ごとの最新 fingerprint を求める(1クエリ)。
      const latestRows = await db
        .select({ externalRef: testCaseObservations.externalRef, fingerprint: testCaseObservations.fingerprint })
        .from(testCaseObservations)
        .innerJoin(syncSessions, eq(syncSessions.token, testCaseObservations.syncToken))
        .where(and(
          eq(testCaseObservations.projectId, pid),
          eq(testCaseObservations.origin, session.origin),
          inArray(testCaseObservations.externalRef, refs),
          sql`(${syncSessions.status} = 'committed' OR ${syncSessions.token} = ${session.token})`,
        ))
        .orderBy(desc(testCaseObservations.createdAt), desc(testCaseObservations.id));

      const latestFingerprintByRef = new Map<string, string>();
      for (const r of latestRows) {
        if (!latestFingerprintByRef.has(r.externalRef)) latestFingerprintByRef.set(r.externalRef, r.fingerprint);
      }

      // ② fingerprint が異なる/初出の ref のみ観測 INSERT 候補にする(容量設計の根幹 = 変化点のみ記録)。
      const changedRefs = new Set<string>();
      const obsRows: Record<string, unknown>[] = [];
      for (const o of obs) {
        if (latestFingerprintByRef.get(o.externalRef) === o.fingerprint) continue;
        changedRefs.add(o.externalRef);
        obsRows.push({
          id: uuid(),
          testCaseId: null, // 新規ケースは commit 工程で backfill(data-model.md)
          externalRef: o.externalRef,
          projectId: pid,
          fingerprint: o.fingerprint,
          observed: JSON.stringify(o.observed),
          syncToken: session.token,
          origin: session.origin,
          confidence: o.confidence,
          category: o.category,
          createdAt: now,
        });
      }

      // ③ 受信した全 ref(重複除去済み)を出現台帳へ。commit 工程3/4(Task 16)は観測ではなくここを
      // 参照することで、変化なし ref(観測行が作られない)の再出現を stale に誤判定しない(⚠ 設計ノート)。
      const seenRows = refs.map((r) => ({ syncToken: session.token, externalRef: r }));

      // 各チャンクを個別の driver.batch() 呼び出し(1呼び出し=1文)として実行する。各文は
      // ON CONFLICT DO NOTHING で冪等・自己完結のため、単一の巨大トランザクションにまとめなくても
      // 途中失敗時の不変条件("chunk 失敗は観測が足りないだけ"。sync-protocol.md)は保たれる。
      for (const batch of toBatches(obsRows, OBSERVATION_BATCH_ROWS)) {
        await driver.batch([db.insert(testCaseObservations).values(batch).onConflictDoNothing()]);
      }
      for (const batch of toBatches(seenRows, SEEN_BATCH_ROWS)) {
        await driver.batch([db.insert(syncSeen).values(batch).onConflictDoNothing()]);
      }

      // ④ outcome は①の「変化があったか」のみを根拠にする(INSERT の実際の affected 行数ではない)。
      // 同一チャンク再送・並行二重処理は ON CONFLICT DO NOTHING が DB 側で吸収するが、outcome の分類自体は
      // 常に①のフェンス付き比較で決まるため、再送であっても一貫した 'duplicate' を返す。
      return obs.map((o) => ({
        external_ref: o.externalRef,
        outcome: (changedRefs.has(o.externalRef) ? 'inserted' : 'duplicate') as 'inserted' | 'duplicate',
      }));
    },
  } satisfies Storage;

  return storage;
}
