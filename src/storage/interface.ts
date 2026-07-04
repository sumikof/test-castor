// src/storage/interface.ts
import type {
  OrganizationRow, UserRow, SessionRow, ProjectRow, ApiTokenRow, TestCaseRow, TestCaseHistoryRow,
  TestCaseIdentityRow, TestCaseObservationRow, SyncSessionRow,
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
 * patchTestCase の結果種別。not_found は書き込み前の存在チェックで、conflict/ok は書き込み(UPDATE)の
 * 実際の affected 行数(0 行 = conflict、1 行以上 = ok)で判別する。事前チェックのスナップショットと
 * expectedVersion の一致・不一致では判別しない(review round 1: CRITICAL OCC concurrency 参照)。
 */
export type PatchResult = { kind: 'ok'; row: TestCaseRow } | { kind: 'conflict' } | { kind: 'not_found' };

/** patchTestCase の入力(domain.computeHumanPatch の出力 + OCC/actor/時刻)。 */
export interface PatchTestCaseParams {
  /** If-Match から parse した version(存在しない場合は呼び出し側が 428 を返し、ここへは来ない)。 */
  expectedVersion: number;
  /**
   * domain.computeHumanPatch の columnValues(実変更があった人間所有列のみ)。version/ownership も
   * 含まれるが、これらは呼び出し元のスナップショット(current.version+1 等)から計算された値であり、
   * drizzle-storage.ts の実装はこの2キーを無視して UPDATE 文内で現在行を基準に SQL 側で導出する
   * (version=version+1 / ownershipTransition なら CASE 式)。並行更新下でも自己検証的に正しい書き込みに
   * するための意図的な設計(review round 1: CRITICAL OCC concurrency 参照)。
   */
  columnValues: Record<string, unknown>;
  /**
   * true の場合、SET 句に「ownership が machine なら human へ遷移」の CASE 式を含める
   * (machine→human の不可逆遷移。同一 UPDATE 文。現在行基準で導出するため 'human' 固定値は使わない)。
   */
  ownershipTransition: boolean;
  /** UPDATE が実際に1行以上へ命中したときにのみ追記される TestCaseHistory 行(0件・1件・2件のいずれもありうる)。 */
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

// --- sync(task-15-brief.md「Produces(Storage 追加分)」。start/chunk のみ。commit は Task 16)---

/**
 * POST /sync/:token/chunk の1件分の入力(HTTP 層が Zod 検証済み observationSchema を camelCase に
 * 整形して渡す)。observation トップレベルの source_ref は data-model.md の observed 固定キーセット内
 * (observed.source_ref)と重複するため、Storage 層へは渡さない(task-15 のスコープ外。タスク報告参照)。
 */
export interface ChunkObservation {
  externalRef: string;
  fingerprint: string;
  /** 固定キーセット(data-model.md「observed の固定キーセット」)。JSON文字列化して保存する。 */
  observed: Record<string, unknown>;
  /**
   * observation のトップレベル任意フィールド(task-15-brief.md「もう1つの docs ギャップ」)。
   * 未指定(null)時のデフォルト('normal')適用は Task 16 の canonical 生成側の責務。
   */
  category: Category | null;
  confidence: number | null;
}

export type SyncStartResult = { kind: 'created'; session: SyncSessionRow } | { kind: 'conflict' };

export interface SyncAppendOutcome { external_ref: string; outcome: 'inserted' | 'duplicate' }

// --- sync commit(task-16-brief.md「Produces(Storage 追加分)」。工程0〜8)---

/**
 * syncCommitWindow の入力(task-16-brief.md)。identityTtlMs は工程7(rollup)の TTL、windowLimit は
 * 工程3〜7 の rowid ウィンドウ幅(1回の呼び出しで各工程が処理する最大行数)。
 *
 * actor: 工程1(Canonical 生成)の history INSERT(action='imported')に使う型付き参照
 * `'token:<apiTokenId>'`。task-16-brief.md のインターフェース原文にはこの引数が無いが、
 * sync-protocol.md/工程実装対応表が明示する「actor='token:<apiTokenId>'」を満たすには commit を
 * 呼んだ Bearer トークンの id が必要で、Storage 層の外(HTTP ルート)にしか存在しない情報のため、
 * ここに追加した(ブリーフのシグネチャ抜けと判断。タスク報告に明記)。
 */
export interface SyncCommitWindowParams {
  now: number;
  identityTtlMs: number;
  windowLimit: number;
  actor: string;
}
export interface SyncCommitWindowResult { more: boolean }

export interface SyncFinalizeResult {
  createdCount: number;
  changedCount: number;
  staledCount: number;
  alreadyCommitted: boolean;
}

export type SyncMappingOutcome = 'created' | 'updated' | 'unchanged';
export interface SyncMappingItem { externalRef: string; testCaseId: string; outcome: SyncMappingOutcome }

export interface SyncStatusOrigin {
  origin: string;
  lastCommittedAt: number;
  lastSummary: { created: number; changed: number; staled: number };
}
export interface SyncStatusResult {
  origins: SyncStatusOrigin[];
  current: { unreviewed: number; drift: number; stale: number };
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

  // --- test cases 書き込み系(task-14-brief.md。OCC 系2メソッドの自己検証戦略は
  // review round 1: CRITICAL OCC concurrency で確定。詳細な理由は drizzle-storage.ts の実装コメント参照)---
  /**
   * OCC 付き単一 UPDATE(apis/testcases.md「PATCH /testcases/:id」・data-model.md「OCC」)。
   *
   * 事前チェック(getTestCase)は「id が存在するか」の判定(not_found)にのみ使い、conflict の判定には
   * 使わない(事前チェックのスナップショットと expectedVersion の一致・不一致は、2つのリクエストが
   * 同じ version を読んでから競走する真の並行レースを検出できないため)。
   *
   * SET は columnValues(人間所有列の実変更分。version/ownership は無視する)+ human_updated_at=now +
   * version=version+1(現在行基準の SQL 相対式)+ ( ownershipTransition なら ownership を machine→human
   * へ遷移させる CASE 式)を1つの UPDATE 文にまとめ、WHERE id=:id AND project_id=:pid AND
   * version=:expectedVersion で原子的に排他する。No-op PATCH(changes 空)はこのメソッドを呼ばず
   * 呼び出し側(ルートハンドラ)が現在値を 200 で返す契約(このメソッドは常に「書き込みを試みる」)。
   *
   * conflict/ok の判定は UPDATE の実際の affected 行数(driver.batch の戻り値。事前チェック済みなので
   * 0行=version 不一致による conflict、1行以上=ok)のみを根拠にする。historyEntries は同一 batch 内で
   * changes()>0 のときにのみ実際に INSERT されるガード付き文として渡す(UPDATE が0行でも history だけが
   * 増える phantom entry を防ぐ)。ok の場合、返す row は書き込み後に再 SELECT した実際の値(SQL 側で
   * 導出した version/ownership を含む)。
   */
  patchTestCase(scope: OrgScope, pid: string, id: string, p: PatchTestCaseParams): Promise<PatchResult>;
  /**
   * アーカイブ(apis/testcases.md「DELETE /testcases/:id」、スペック D-02: PATCH のセマンティック
   * エイリアス)。OCC 不要(WHERE に version 条件を含めない)・冪等(既に archived なら現状をそのまま返す。
   * UPDATE/history 共に発生しない)。
   *
   * 未 archived の場合、status='archived' + version=version+1(現在行基準の SQL 相対式)+
   * ( machine 所有なら ownership を human へ遷移させる CASE 式。複合不変条件
   * `status IN ('approved','archived') ⇒ ownership='human'` を満たすため)+ history(status_changed)を
   * 1つの driver.batch で書く。version/ownership を事前チェックのスナップショットではなく現在行基準の
   * SQL 式で導出するのは、事前チェックと UPDATE の間に着地した並行更新(例: 別リクエストの
   * patchTestCase)を古い値で巻き戻さないため。WHERE には `status != 'archived'` も埋め込み、2つの同時
   * archive リクエストが競走しても後着側の UPDATE は0行に短絡する(history もガードにより増えない)。
   * affected 行数は分岐に使わない(0行=既に他方が archived 済みでも、望んだ終状態には到達しているため
   * 常に成功として現在値を返す。never 409)。id が存在しなければ null。
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
   * 現在行が存在しなければ not_found、drift=false なら no_drift(この判定は version と独立した
   * 業務ルール上の前提条件チェックのため、事前チェックのままでよい。OCC のすり抜けとは無関係)。
   *
   * drift=true の場合、getLatestCommittedObservation(mirror_origin 由来)の fingerprint を採用し、
   * drift=0・version=version+1(現在行基準の SQL 相対式。expectedVersion+1 というスナップショット値では
   * ない)・human_updated_at=now を1つの UPDATE 文(WHERE version=expectedVersion)で書く。
   *
   * conflict/ok の判定は patchTestCase と同じく UPDATE の実際の affected 行数(driver.batch の戻り値)
   * のみを根拠にする(0行=conflict。存在は直前に確認済みのため not_found にはならない)。history は
   * 同一 batch 内で changes()>0 のときにのみ実際に INSERT されるガード付き文として status_changed を渡す。
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

  // --- sync(task-15-brief.md。start/chunk の前半のみ。commit(工程0-8)は Task 16)---

  /**
   * 遅延評価(sync-protocol.md「失効の執行モデル」): 対象 (project, origin) の active セッションで
   * expires_at<=now のものを expired に倒す。origin=null はプロジェクト全体が対象(Cron sweep 等)。
   * syncStart 自身はこれを呼ばず、同じ効果を持つ UPDATE を自身の batch に inline する(下記参照)。
   */
  syncExpireLapsed(scope: OrgScope, pid: string, origin: string | null, now: number): Promise<void>;
  /**
   * 新規 active セッションを開始する(sync-protocol.md「POST /sync/start」)。実装は
   * batch([対象 origin の期限切れ active を expired に倒す UPDATE, 新規 active INSERT])を1トランザクション
   * で実行し、部分一意索引 uq_active_session(project_id,origin) WHERE status='active' への違反を
   * catch して conflict として返す(この UPDATE は syncExpireLapsed と同じ述語だが、INSERT と同一 batch
   * に inline する必要があるため独立した実装を持つ)。
   */
  syncStart(
    scope: OrgScope, pid: string, p: { token: string; origin: string; now: number; slidingMs: number },
  ): Promise<SyncStartResult>;
  /** token+pid で1件取得(project 境界)。存在しなければ null。 */
  syncGetSession(scope: OrgScope, pid: string, token: string): Promise<SyncSessionRow | null>;
  /**
   * スライディング失効の延長(sync-protocol.md「スライディング失効」)。token は認証済み・存在確認済みの
   * セッション PK であるため scope 引数を取らない(touchTokenLastUsed と同じ規約。GC-5 の追加の例外)。
   */
  syncTouchExpiry(token: string, expiresAt: number): Promise<void>;
  /**
   * 観測を追記する(sync-protocol.md「変化点のみ記録」+ task-15-brief.md「出現台帳」設計ノート)。
   * ① committed-JOIN フェンス(committed セッション由来 OR 当セッション自身の観測)で対象 ref 群の
   *    「最新観測 fingerprint」を取得する
   * ② fingerprint が異なる/初出の ref のみ観測 INSERT 候補にする(1文あたり複数行に分割・
   *    ON CONFLICT DO NOTHING。D1「1文あたり bind ≤ 100」対応。test_case_observations は1行11列の
   *    フルバインドのため8行/文(88 bind)。brief の目安値「≤16行/文」は sync_seen(2列)側で採用し、
   *    観測側は実列数から逆算した値に調整している。詳細・実測根拠は drizzle-storage.ts の実装コメント参照)
   * ③ 受信した全 ref を sync_seen へ INSERT(16行/文・ON CONFLICT DO NOTHING)。Task 16 の
   *    commit 工程3/4 は観測ではなくここを参照することで、変化なし ref の再出現を stale に誤判定しない
   * ④ 観測 INSERT された ref → 'inserted'、それ以外(fingerprint 不変で観測を作らなかった ref)→ 'duplicate'
   */
  syncAppendObservations(
    scope: OrgScope, pid: string, session: SyncSessionRow, obs: ChunkObservation[], now: number,
  ): Promise<SyncAppendOutcome[]>;

  // --- sync commit(task-16-brief.md。工程0-8)---

  /**
   * commit 工程0〜7 を実行する(sync-protocol.md「Commit 8工程パイプライン」)。
   * 工程0(同定採番)〜工程2(Identity 生成)は毎回全件を完了させる(D1 bind 上限に収まるようバッチ分割
   * するのみ)。工程3(last_seen 確定+un-stale)〜工程7(Rollup)は
   * `WHERE rowid IN (SELECT rowid FROM ... WHERE <述語> LIMIT :windowLimit)` パターン
   * (notes.md 実装標準。素の UPDATE...LIMIT は不使用)で1回の呼び出しあたり最大 windowLimit 行に
   * 限定する。5工程のいずれかが実際に windowLimit 行へ到達した(=まだ残りがあるかもしれない)場合
   * `more:true` を返し、呼び出し側(commit ルート)は同一トークンで再度呼び出す。全工程が冪等
   * (WHERE 述語が「まだ適用されていない行」のみに絞り込む)ため、繰り返し呼んでも収束する。
   *
   * 工程3/4 の参照元は sync_seen(Task 15 ノートどおり。TestCaseObservation ではない。
   * 変化点のみ記録のため観測を参照すると無変化 ref を誤って stale 判定してしまうため)。
   */
  syncCommitWindow(scope: OrgScope, pid: string, token: string, p: SyncCommitWindowParams): Promise<SyncCommitWindowResult>;

  /**
   * commit 工程8(セッション確定)。COUNT 3本(created=SyncStaging行数/changed=DISTINCT external_ref in
   * observations(:T)/staled=(P,O)で last_seen_sync_token!=:T の identity 数)を、`UPDATE sync_sessions
   * SET status='committed', committed_at, *_count WHERE token=:T AND status='active'` の SET 句に
   * 相関サブクエリとして畳み込んだ**単一 UPDATE 文**で書く(スペック D-01「同一バッチ」)。review round 1
   * 以前は3本の SELECT COUNT を先に実行してから別文で UPDATE していたため、読み取りと書き込みの間に
   * 他プロセスが割り込める TOCTOU が残っていた(drizzle-storage.ts の実装コメント参照)。相関サブクエリ化
   * によりカウント算出と committed 遷移が物理的に1文になり、この隙間が構造的に無くなる。
   *
   * 冪等: 呼び出し時点で既に committed なら、UPDATE 自体を実行せず保存済みの *_count をそのまま返し
   * `alreadyCommitted:true`。UPDATE の対象行が(競合等で)0件だった場合も同様に保存済み値へフォール
   * バックする(`AND status='active'` により2重 finalize が2重に着地しない)。
   */
  syncFinalize(scope: OrgScope, pid: string, token: string, now: number): Promise<SyncFinalizeResult>;

  /**
   * 当該トークンの `external_ref → test_case_id` マップ(sync-protocol.md commit レスポンス例の
   * `mappings`)。created=SyncStaging に有る/updated=観測(:T)が有る(staging 除く)/
   * unchanged=sync_seen のみ(分類ロジックは domain/sync-commit.ts の classifySyncMappings)。
   * staled(今回未出現)は含めない(syncFinalize の staledCount で報告。task-16-brief.md 注記)。
   */
  syncMappings(scope: OrgScope, pid: string, token: string): Promise<SyncMappingItem[]>;

  /**
   * GET /sync/status(スペック D-01)。origins は origin 別の最新 committed セッション
   * (committed セッションが無い origin は含めない)。current は非 archived の
   * unreviewed(status=draft AND ownership=machine)/drift(drift=true)/stale(is_stale=true)件数。
   */
  syncStatus(scope: OrgScope, pid: string): Promise<SyncStatusResult>;

  // --- maintenance(task-22-brief.md。CF scheduled と node CLI(Task 23)の双方から src/maintenance/
  // 経由で呼ばれる低レベルプリミティブ)---
  //
  // GC-5 との関係(タスク報告に明記する既知の緊張): GC-5は「Storage の全メソッドは第一引数に
  // orgScope」と定めるが、以下5メソッドはブリーフが明示するとおり orgScope を取らない。
  // これらはプロジェクト横断・システム全体のメンテナンス操作(観測パージ・失効 sweep・行数監視)であり、
  // 特定 org の業務データ操作ではないため、ブリーフの明示シグネチャをそのまま実装する
  // (per-org スコープをここで独自に発明しない)。

  /**
   * committed観測の期間パージ(operations.md §4.1「パージの削除述語」)。1回の呼び出しで
   * `rowid IN (SELECT rowid FROM ... LIMIT :batchLimit)` の1文のみを実行し、実際に削除した行数を
   * 返す(syncCommitWindow の windowLimit と同じ「1回の呼び出し=1バッチ」設計。閾値未満になるまで
   * 繰り返し呼ぶのは呼び出し側 = src/maintenance/purge.ts の責務)。
   *
   * 述語(committed セッション由来のみ・retention 超・per-(test_case_id,origin) 最低1件保持の
   * ROW_NUMBER)は operations.md の SQL 例をそのまま実装するが、素の `DELETE...LIMIT` は使わず
   * notes.md 実装標準の rowid サブクエリパターンに翻訳する(libSQL 互換性のため。タスク報告参照)。
   */
  purgeObservations(p: { now: number; retentionMs: number; batchLimit: number }): Promise<number>;
  /**
   * 失効した SyncSession を expired に倒す(sync-protocol.md「失効の執行モデル」のセカンダリ = Cron
   * sweep。正しさは各エンドポイントの遅延評価(syncExpireLapsed 等)が担保する)。全プロジェクト対象
   * (project 単位の遅延評価は既存の syncExpireLapsed が担う)。LIMIT なしの単一 UPDATE(対象は「現在
   * active な期限切れセッション」のみで長期的に蓄積しないため、複数バッチに分ける必要がない)。
   */
  sweepExpiredSyncSessions(now: number): Promise<number>;
  /** 期限切れ UI セッション(`sessions` テーブル)を limit 件まで削除する。purgeObservations と同じく
   * 1回の呼び出し=1バッチ(rowid IN (SELECT rowid ... LIMIT :limit))。反復は呼び出し側の責務。 */
  deleteExpiredUiSessions(now: number, limit: number): Promise<number>;
  /**
   * committed/expired セッションの sync_staging + sync_seen(セッション寿命のみの作業データ。
   * schema.ts の設計ノートどおり確定/失効後にパージ対象)を削除し、2テーブル合計の削除行数を返す。
   * ブリーフのシグネチャは引数を取らない(now/batchLimit を露出しない)ため、内部バッチ幅は固定定数
   * (drizzle-storage.ts 参照)。1回の呼び出しで各テーブル最大 定数件・計2文のみ実行し、反復は
   * 呼び出し側(src/maintenance/purge.ts)の責務とする(他の3メソッドと対称的な設計)。
   */
  purgeSyncWorkdata(): Promise<number>;
  /**
   * 主要テーブルの行数スナップショット(概算容量監視ログ用。operations.md §4.2「監視」)。
   * data-model.md のエンティティ関係図が定義する11エンティティのみを対象にする(sync_seen は
   * data-model.md/sync-protocol.md 未記載の内部実装専用テーブルのため対象外。schema.ts 参照)。
   */
  countsSnapshot(): Promise<Record<string, number>>;
}
