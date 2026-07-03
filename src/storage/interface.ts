// src/storage/interface.ts
import type {
  OrganizationRow, UserRow, SessionRow, ProjectRow, ApiTokenRow, TestCaseRow, TestCaseHistoryRow,
  TestCaseIdentityRow, TestCaseObservationRow,
} from './schema';
import type { Role, Status, Category, Ownership, HistoryAction, BulkAction } from '../schemas/enums';
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

// --- test cases 書き込み系(task-14-brief.md「Produces(Storage 追加分)」)---

/**
 * patchTestCase の結果種別。changed rows が 0 の場合、呼び出し側は id の存在確認により
 * conflict(存在するが version 不一致)/ not_found(そもそも存在しない)を判別する。
 */
export type PatchResult = { kind: 'ok'; row: TestCaseRow } | { kind: 'conflict' } | { kind: 'not_found' };

/** patchTestCase の入力(domain.computeHumanPatch の出力 + OCC/actor/時刻)。 */
export interface PatchTestCaseParams {
  /** If-Match から parse した version(存在しない場合は呼び出し側が 428 を返し、ここへは来ない)。 */
  expectedVersion: number;
  /** domain.computeHumanPatch の columnValues(実変更があった人間所有列のみ。version/ownership を含む)。 */
  columnValues: Record<string, unknown>;
  /** true の場合、SET 句に ownership='human' を含める(machine→human の不可逆遷移。同一 UPDATE 文)。 */
  ownershipTransition: boolean;
  /** 同一 UPDATE の成功時にのみ追記する TestCaseHistory 行(0件・1件・2件のいずれもありうる)。 */
  historyEntries: NewHistoryEntry[];
  now: number;
}

export type AcceptFingerprintResult =
  | { kind: 'ok'; row: TestCaseRow }
  | { kind: 'conflict' }
  | { kind: 'no_drift' }
  | { kind: 'not_found' };

export interface BulkActionResult {
  updated: number;
  skipped: number;
  errors: Array<{ id: string; code: string; message: string }>;
}

/** GET /testcases/:id/observations のクエリフィルタ(origin 任意)。 */
export interface ObservationFilters { origin?: string }

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

  // --- test cases 書き込み系(task-14-brief.md)---
  /**
   * OCC 付き単一 UPDATE(apis/testcases.md「PATCH /testcases/:id」・data-model.md「OCC」)。
   * SET は columnValues(人間所有列の実変更分)+ human_updated_at=now + ( ownershipTransition なら
   * ownership='human' )を1つの UPDATE 文にまとめ、WHERE id=:id AND project_id=:pid AND
   * version=:expectedVersion で原子的に排他する。No-op PATCH(changes 空)はこのメソッドを呼ばず
   * 呼び出し側(ルートハンドラ)が現在値を 200 で返す契約(このメソッドは常に「書き込みを試みる」)。
   * 変更行数が 0 の場合、id の存在有無で conflict(存在するが version 不一致)/ not_found を判別する。
   * historyEntries は UPDATE 成功時にのみ追記する(失敗時は 0 行のまま。history の追記専用性を保つ)。
   */
  patchTestCase(scope: OrgScope, pid: string, id: string, p: PatchTestCaseParams): Promise<PatchResult>;
  /**
   * アーカイブ(apis/testcases.md「DELETE /testcases/:id」、スペック D-02: PATCH のセマンティック
   * エイリアス)。OCC 不要・冪等(既に archived なら現状をそのまま返す。UPDATE/history 共に発生しない)。
   * 未 archived の場合のみ status='archived'(+ machine 所有なら ownership='human'。複合不変条件
   * `status IN ('approved','archived') ⇒ ownership='human'` を満たすため)+ history(status_changed)を
   * 1つの driver.batch で書く。id が存在しなければ null。
   */
  archiveTestCase(scope: OrgScope, pid: string, id: string, actor: string, now: number): Promise<TestCaseRow | null>;
  /**
   * 一括操作(apis/testcases.md「POST /testcases/bulk」)。SELECT で対象行をまとめて取得し、
   * 各行に domain.applyBulkAction を適用した結果を集計する。実際に UPDATE が必要な行のみ
   * (UPDATE, history INSERT)のペアを1つの driver.batch にまとめて実行する(OCC は使用しない)。
   * ids に存在しない id が含まれる場合は errors に `NOT_FOUND` として計上する。
   */
  bulkAction(
    scope: OrgScope, pid: string, ids: string[], action: BulkAction, actor: string, now: number,
  ): Promise<BulkActionResult>;
  /**
   * drift 解消(apis/testcases.md「POST /testcases/:id/accept-fingerprint」)。OCC 付き。
   * 現在行が存在しなければ not_found、drift=false なら no_drift(OCC より前に判定する)。
   * drift=true の場合、getLatestCommittedObservation(mirror_origin 由来)の fingerprint を採用し、
   * drift=0・version=expectedVersion+1・human_updated_at=now を1つの UPDATE 文(WHERE version=
   * expectedVersion)で書く。変更行数が 0 なら conflict(存在は直前に確認済みのため not_found にはならない)。
   * 成功時のみ TestCaseHistory に status_changed を追記する。
   */
  acceptFingerprint(
    scope: OrgScope, pid: string, id: string, expectedVersion: number, actor: string, now: number,
  ): Promise<AcceptFingerprintResult>;
  /** per-origin の同定情報(apis/testcases.md「GET /testcases/:id/identities」)。ページングなし。 */
  listIdentities(scope: OrgScope, pid: string, id: string): Promise<TestCaseIdentityRow[]>;
  /**
   * committed セッション由来の観測のみ(JOIN sync_sessions.status='committed'。data-model.md「意味論的
   * 隔離」)を時系列で返す(apis/testcases.md「GET /testcases/:id/observations」)。origin 任意フィルタ。
   */
  listObservations(
    scope: OrgScope, pid: string, id: string, p: ObservationFilters & Page,
  ): Promise<Paged<TestCaseObservationRow>>;
  /**
   * 当該テストケースの mirror_origin 由来・committed セッションの最新観測(data-model.md「drift」の
   * 基準列)。diff・accept-fingerprint の両方で使う。mirror_origin が null(手動作成)なら null。
   */
  getLatestCommittedObservation(scope: OrgScope, pid: string, id: string): Promise<TestCaseObservationRow | null>;
}
