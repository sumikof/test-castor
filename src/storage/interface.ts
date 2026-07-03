// src/storage/interface.ts
import type {
  OrganizationRow, UserRow, SessionRow, ProjectRow, ApiTokenRow, TestCaseRow, TestCaseHistoryRow,
} from './schema';
import type { Role, Status, Category, Ownership, HistoryAction } from '../schemas/enums';
import type { ParamRow } from '../domain/testcase-rules';

export interface OrgScope { organizationId: string }

export interface SetupParams {
  orgName: string; adminEmail: string; adminPasswordHash: string; adminDisplayName: string; now: number;
}
export interface CreateUserParams {
  email: string; passwordHash: string; displayName: string; role: Role; now: number;
}

// --- test cases(task-13-brief.md「Produces(Storage 追加分)」)---

/** GET 一覧のクエリフィルタ(docs/apis/testcases.md「クエリパラメータ」)。すべて AND 結合。 */
export interface TestCaseFilters {
  status?: Status;
  category?: Category;
  ownership?: Ownership;
  drift?: boolean;
  isStale?: boolean;
  /** 部分一致検索(LIKE '%'||target||'%')。LIKE メタ文字(%, _)は呼び出し先でエスケープする。 */
  target?: string;
}

/** カーソルベースページング入力(api-reference.md「カーソルベースページング」)。 */
export interface Page { cursor?: string; limit: number }

/** カーソルベースページング応答。total は同フィルタの EXACT COUNT(D-03)。 */
export interface Paged<T> { items: T[]; total: number; nextCursor: string | null; hasMore: boolean }

/**
 * 手動作成(POST /testcases)の入力列。ownership='human'・created_origin='manual'・version=1・
 * is_stale=0・drift=0・fingerprint=null・mirror_origin=null は Storage 側が固定で設定するため
 * ここには含めない(呼び出し側 = ルートハンドラが決めるのは以下の入力由来フィールドのみ)。
 */
export interface NewTestCaseColumns {
  title: string;
  target: string | null;
  category: Category;
  given: string;
  when: string;
  then: string;
  parameters: ParamRow[] | null;
  status: Status;
  confidence: number | null;
  sourceRef: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

/** TestCaseHistory への追記1件分(actor は型付き参照 'user:<id>' | 'token:<id>')。 */
export interface NewHistoryEntry {
  actor: string;
  action: HistoryAction;
  delta: Record<string, unknown>;
}

export interface Storage {
  // --- setup / organization ---
  countOrganizations(): Promise<number>;
  /** 組織+admin を単一トランザクションで作成(apis/setup.md 業務ルール) */
  setupOrganization(p: SetupParams): Promise<{ organization: OrganizationRow; user: UserRow }>;

  // --- users ---
  /** ログイン用。email はorg内一意(MVPは単一org運用)。global 検索で LIMIT 1 */
  findUserForLogin(email: string): Promise<UserRow | null>;
  /**
   * authn ミドルウェア専用・scope なし。APIハンドラでは使用禁止(GC-5 の唯一の例外)。
   * セッション→ユーザー解決の時点では org がまだ判明していない(Session 行は user_id のみ持つ)ため、
   * org スコープを要求できない。ここで得た UserRow から org を確定させた後は、以後の全ハンドラ処理が
   * 通常の scope 付きメソッド(getUser 等)を経由すること。
   */
  getUserById(id: string): Promise<UserRow | null>;
  getUser(scope: OrgScope, id: string): Promise<UserRow | null>;
  listUsers(scope: OrgScope): Promise<UserRow[]>;
  createUser(scope: OrgScope, p: CreateUserParams): Promise<UserRow | 'email_taken'>;
  updateUser(scope: OrgScope, id: string, patch: { role?: Role; displayName?: string }, now: number): Promise<UserRow | null>;
  /**
   * Atomically change a user's role, refusing to demote the last admin (guard is in the
   * UPDATE's WHERE so it's race-free on the single-writer DB).
   */
  setUserRoleGuarded(scope: OrgScope, id: string, newRole: Role, now: number): Promise<'ok' | 'blocked_last_admin' | 'not_found'>;
  countAdmins(scope: OrgScope): Promise<number>;
  setUserPassword(scope: OrgScope, userId: string, passwordHash: string, now: number): Promise<void>;
  touchLastLogin(scope: OrgScope, userId: string, now: number): Promise<void>;

  // --- sessions(署名検証は Auth 層。ここは DB 存在・失効のみ)---
  createSession(row: SessionRow): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  deleteSession(id: string): Promise<void>;
  deleteUserSessions(userId: string, exceptSessionId?: string): Promise<void>;

  // --- projects ---
  listProjects(scope: OrgScope): Promise<Array<ProjectRow & { testcaseCount: number }>>; // D-05: 非archived件数
  getProject(scope: OrgScope, pid: string): Promise<ProjectRow | null>;
  createProject(scope: OrgScope, p: { name: string; repoUrl?: string | null }, now: number): Promise<ProjectRow>;
  updateProject(scope: OrgScope, pid: string, patch: { name?: string; repoUrl?: string | null }, now: number): Promise<ProjectRow | null>;

  // --- api tokens ---
  createApiToken(scope: OrgScope, pid: string, name: string, tokenHash: string, now: number): Promise<ApiTokenRow>;
  listApiTokens(scope: OrgScope, pid: string): Promise<ApiTokenRow[]>;
  /** 冪等ソフト失効(apis/tokens.md)。存在しなければ null */
  revokeApiToken(scope: OrgScope, pid: string, tokenId: string, now: number): Promise<ApiTokenRow | null>;
  /** 認証述語: token_hash 完全一致 AND revoked_at IS NULL(auth-security.md) */
  findApiTokenByHash(tokenHash: string): Promise<(ApiTokenRow & { organizationId: string }) | null>;
  /** best-effort 間引き更新: 前回更新から thresholdMs 経過時のみ書く */
  touchTokenLastUsed(tokenId: string, now: number, thresholdMs: number): Promise<void>;

  // --- test cases ---
  /**
   * 手動作成(apis/testcases.md「POST /testcases」業務ルール)。TestCase INSERT と
   * TestCaseHistory INSERT(action='created')を単一の driver.batch で原子的に行う。
   */
  createTestCaseManual(
    scope: OrgScope, pid: string, row: NewTestCaseColumns, history: NewHistoryEntry, now: number,
  ): Promise<TestCaseRow>;
  /** id が pid のテストケースでなければ null(他 project の id は null。project 境界)。 */
  getTestCase(scope: OrgScope, pid: string, id: string): Promise<TestCaseRow | null>;
  /**
   * 並び順 created_at DESC, id DESC。total は同フィルタ(カーソル除く)の EXACT COUNT(D-03)。
   * カーソルは domain/cursor.ts の encodeCursor/decodeCursor で扱う不透明トークン。不正なカーソルは
   * decodeCursor が null を返す契約により「先頭から」にフォールバックする。
   */
  listTestCases(scope: OrgScope, pid: string, filters: TestCaseFilters, page: Page): Promise<Paged<TestCaseRow>>;
  /**
   * 変更履歴(docs/apis/testcases.md「GET /testcases/:id/history」)。actorDisplay は D-04:
   * actor='user:<id>' なら users.display_name、'token:<id>' なら api_tokens.name、
   * どちらにも解決できなければ actor の生値。
   */
  listHistory(
    scope: OrgScope, pid: string, id: string, page: Page,
  ): Promise<Paged<TestCaseHistoryRow & { actorDisplay: string }>>;
}
