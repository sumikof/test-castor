# TMS 開発引き継ぎ書 — MVP 完了時点（2026-07-03）

> 対象読者: 次の開発サイクル（post-MVP）を始める開発者。
> この 1 枚で「現在地・後始末・開発方針・未実装の全量」が分かることを目的とする。
> 正本の所在: 仕様の決定は `docs/superpowers/specs/2026-07-02-tms-mvp-build-design.md`（D-01〜D-14）、実装計画は `docs/superpowers/plans/2026-07-02-tms-mvp-build.md`（23 タスク + GC-1〜GC-10）。docs/ は Task 23 で実装と突合済み（「実装済みの事実のみ」記載の原則）。

---

## 1. 現在地（TL;DR）

- **MVP 完成。本体は `78bad84` として main へ fast-forward マージ済み**（2026-07-03）。以降のドキュメント整備コミット（本書自身を含む）で main はこの先に進むため、最新 SHA は `git log` を正とする。
- 全 23 タスク実装 + タスク単位レビュー + 最終 whole-branch レビュー完了。**760 テスト green**（unit 376 / workers 統合 384）、typecheck 0 エラー。
- E2E 実証済み: `wrangler dev` に対する curl ウォークスルー（セットアップ→ログイン→プロジェクト→トークン発行→sync start/chunk/commit→status→approve）、Node エントリ起動 smoke（`/login`・静的配信・404）。
- 最終レビューで Critical 1 件（sync commit 工程 6 の drift 収束ガード欠落 = 同期恒久ハング）を捕捉し `ba83f44` で修正・回帰テスト済み。Important 0 件。

### 未完の後始末（最初にやること）

1. **origin へ未 push**。開発環境に ssh が無く push できていない。→ `git push origin main`
2. worktree `/workspace/.claude/worktrees/tms-mvp-build` とブランチ `worktree-tms-mvp-build` が残置（ハーネス管理）。worktree を削除した後 `git branch -d worktree-tms-mvp-build`（完全マージ済みなので安全に通る）。
3. worktree 内 `.superpowers/sdd/`（SDD 台帳・レビュー diff 一式）は **gitignored のため worktree 削除で消える**。本書がその要点の恒久版。

---

## 2. プロダクト概要・スタック・アーキテクチャ

**TMS（Test Case Management System）** = Agentic QA プラットフォームのハブ。テストケースの人手管理 + 外部エージェントからの同期取り込み（sync start/chunk/commit）・drift/stale 検知・レビューを担う Web サービス。

**スタック:** TypeScript(strict/ESM) / Cloudflare Workers + Hono ^4 / D1 + Drizzle ORM ^0.44 / Zod ^4 / Hono JSX SSR + HTMX 2(self-host) / Vitest ~3.2 + @cloudflare/vitest-pool-workers。オンプレ: @hono/node-server + better-sqlite3 ^12 / @libsql/client。

**アーキテクチャ要点:**
- 単一パッケージのレイヤード・モノリス。依存方向 `http → domain → storage(interface)`。CF 固有コードは storage アダプタと `src/entry/workers.ts` のみ（可搬境界 = Storage / Auth / RateLimiter）。
- Storage は 3 アダプタ（D1 / better-sqlite3 / libSQL）を **共有契約テスト**で等価保証。共有実装は `src/storage/drizzle-storage.ts`（最大ファイル。sync commit 8 工程パイプライン含む）。
- 同期プロトコル: start / chunk / commit。`sync_seen` = 受信した全 external_ref の出現台帳（変化点観測とは別物）。commit は 8 工程 + windowed resume + committed-JOIN フェンス。
- UI: SSR フォームは JS 無しで動く（Progressive Enhancement）。HTMX フラグメントは `HX-Request` ヘッダ判定。全 UI 要素に `docs/screens/**` カタログ準拠の data-testid（将来の E2E 資産）。
- エントリ 3 種: `src/entry/workers.ts`（fetch + scheduled cron）/ `src/entry/node.ts`（オンプレ、`node-ts-loader.mjs` 経由で TS 直接実行）/ `src/entry/maintenance-cli.ts`（OS cron 用）。

**主要ファイル地図:** `src/schemas/*`（Zod 正本・ERROR_CODES 13 件）/ `src/domain/*`（状態機械・patch/bulk/gherkin/diff・cursor）/ `src/storage/schema.ts`（11 テーブル + sync_seen + 部分一意索引、マイグレーション 0000-0002）/ `src/auth/*`（PBKDF2 PHC・HMAC セッション署名）/ `src/ratelimit/*`（固定ウィンドウ、D-14）/ `src/http/middleware/*`（error・authn 3 段・scope・csrf・page-auth）/ `src/http/ui/*`（画面別 tsx + flash + layout）/ `src/maintenance/*`（purge/sweep/runMaintenance、CF-free）。

---

## 3. 開発方針（次の開発でも踏襲すること）

### 3.1 プロセス規律

- **ドキュメント参照義務（GC-1 の精神）:** 実装前に対象領域の docs/ を読み、docs を正として整合確認。食い違いは勝手にコード側で解決せず、明示的に記録して docs 反映を別途行う（「DOCS-RECONCILE」方式。MVP では notes 台帳に集約し Task 23 で一括反映した）。
- **TDD（GC-2）:** テスト先行・失敗確認→実装。**回帰テストは revert-proof**（バグのある旧コードで落ちることを実証してから採用）。
- **識別テスト必須:** カウント/集計/バインドは「空・ゼロ状態」テストでは真バグ（常に 0、誤バインド）をすり抜ける。**非ゼロ・distinct 値の fixture** で識別的に検証する（testcase_count 常時 0 バグ、sync-new-count 誤バインドの教訓）。
- **レビューゲート:** 変更はレビュー（spec 適合 + コード品質の 2 判定）を通す。fix 後は必ず再レビュー。エラーハンドリング系の fix では「**catch のスコープが要求より広くないか**」を必ず確認（T22 で fix が新バグを混入した経路）。
- **サブエージェント運用（SDD を続ける場合）:** superpowers:subagent-driven-development に従う。ブリーフ/レポート/diff はファイル受け渡し。実装者・フィクサーには fork/サブエージェント起動を明示禁止。コミット報告は必ず `git log/status` で実在確認（偽報告が複数回あった）。レビュアーに事前判定を与えない。コントローラが実装者に与えた裁量は、レビュアーにも「controller-authorized」と明示する（T22 で「捏造引用」誤検知の原因になった）。
- **検証コマンド（GC-10）:** `npm run typecheck` / `npm run test:unit` / `npm run test:workers` / `npm test`。重い変更ではコントローラ/開発者自身も全スイートを独立実行する。
- **コミット:** Conventional Commits（feat:/fix:/test:/docs:）で頻繁に。

### 3.2 実装標準（コードに現れる規律）

| 標準 | 内容 |
|---|---|
| ポータブル LIMIT | 素の `UPDATE/DELETE ... LIMIT` は**禁止**（libSQL ビルドが該当コンパイルフラグ無効）。`WHERE rowid IN (SELECT rowid FROM ... WHERE ... LIMIT :n)` を使う。契約テストが検知する |
| OCC 書込 | 事前 check(404/409) + `batch([UPDATE WHERE version, changes()ガード付き history INSERT])` + **影響行数で conflict 判定** + `version = version + 1`（SQL 相対）。`StorageDriver.batch` は `Promise<number[]>` |
| 窓付き UPDATE の収束 | windowed resume する UPDATE は**自己除外述語必須**（例: 工程 6 の `AND drift = 0`）。SQLite は同値 UPDATE も `changes()` に数えるため、除外が無いと livelock + updated_at churn になる（最終レビュー Critical の教訓） |
| D1 バインド上限 | ≤100 変数/文。大きな IN/INSERT は `toBatches`（~90/バッチ）で分割 |
| テナント境界（GC-5） | org スコープ付きデータアクセスは第一引数 `orgScope`。orgScope を取らないのは以下の 16 メソッドのみ（分類と根拠は `docs/auth-security.md`「テナント境界」の例外一覧が正本）: 認証解決 2（`findUserForLogin`・`getUserById`）/ セッションストア 4（`createSession`・`getSession`・`deleteSession`・`deleteUserSessions` — authn 基盤・org 判明前に動く）/ API トークン認証 2（`findApiTokenByHash`・`touchTokenLastUsed`）/ セットアップ 2（`countOrganizations`・`setupOrganization` — テナント成立前）/ メンテナンス 5（`purgeObservations`・`sweepExpiredSyncSessions`・`deleteExpiredUiSessions`・`purgeSyncWorkdata`・`countsSnapshot`）/ 同期セッション 1（`syncTouchExpiry` — 推測不能 sync トークンがキー。interface.ts に「GC-5 の追加の例外」と注記あり）。**新たな例外を増やさない**（増やす場合は interface.ts の注記と auth-security.md の一覧を必ず更新） |
| ポータビリティ（GC-6） | `src/schemas`・`src/domain`・`src/http`・`src/maintenance` から `@cloudflare/workers-types`/D1 型を import しない。CF 固有は adapters と workers エントリのみ |
| エラースキーマ（GC-4） | 全 API エラーは `{error:{code,message,details?,retryable}}` のみ。エントリの bootstrap 失敗も `toErrorResponsePayload` 経由で同スキーマ（素の例外を漏らさない） |
| クロック（GC-3） | 日時は全て epoch ms INTEGER。実クロックを読むのはエントリ層のみ。他は `deps.now()`/引数注入。テストは固定クロック |
| UI | SSR ボタンに `disabled` をハードコードしない（no-JS ロックアウト防止）。HTMX swap 後のフォームは `htmx:afterSwap` で再エンハンス。data-testid は `docs/screens/**` が正本（GC-8） |
| 依存管理（GC-7） | 依存追加は理由を明示して意識的に。MVP は Task 1 の package.json で固定した |

### 3.3 環境メモ

- node v22 必須（`~/node22/bin`。better-sqlite3 は node22 ABI でビルド済み。当時の開発環境は既定 node が v18 だったため全コマンドに `export PATH="$HOME/node22/bin:$PATH" &&` を前置していた）。
- `npm run dev` = wrangler dev。postinstall が htmx を `public/` にコピー。
- オンプレ: `npm run start:node`（`TMS_DB_PATH`・`PORT`）、`npm run maintenance:node`（OS cron 例は README）。env 一覧と `SESSION_SIGNING_KEYS`/`SESSION_ACTIVE_KEY_ID` の規約は README + `docs/auth-security.md`。
- テスト用 wrangler 互換日付は installed workerd の上限（2025-09-06）警告が出るが無害。

---

## 4. 未実装部分の詳細（次の開発の候補リスト）

### 4.1 MVP スコープ外（意図的未実装。正本 = スペック「対象外(MVP 後)」節）

| # | 項目 | 現状と着手時のヒント |
|---|---|---|
| 1 | **S-03/S-04 セルフサービスパスワードリセット** | メール基盤が必要。現在は S-19 の管理者手動リセットで代替。着手時はメール送信の可搬境界（Workers: Email Workers or 外部 API / Node: SMTP）を新設する必要あり |
| 2 | **S-05 ダッシュボード** | 集計 API 未定義のまま据え置き。ログイン後遷移先は S-06 プロジェクト一覧に固定済み（スペック D-13「軽微な解決」第 1 項。コード/プラン内では通称 D-13-1）。`countsSnapshot` が行数概算の下地としてある |
| 3 | **S-21 レポート/CSV エクスポート** | 集計 API 未定義。画面カタログは docs/screens/admin/ に存在するが実装ゼロ |
| 4 | **フリーテキスト検索・テーブルソート** | S-08 のフィルタ（status/origin/drift/stale/ownership）は実装済み。検索・ソートは未実装。カーソルページング（D-03: exact total + browser-history 風）との整合設計が必要 |
| 5 | **Gherkin エクスポートボタン** | 表示タブ + コピー機能は実装済み。ファイルエクスポートは未実装 |
| 6 | **re-adopt API（human→machine 復帰）** | D-12 で MVP 後と決定。data-model.md に `[※MVP後]` 注記済み。状態機械 `src/domain/testcase-rules.ts` に追加する形になる |
| 7 | **ユーザー無効化・テストレベル分類・コメント/メモ・招待メール** | 全て未着手。ユーザーは削除ではなく無効化フラグの設計から必要 |
| 8 | **実環境への wrangler deploy** | 手順書（README）のみ整備。`wrangler.jsonc` の database_id は `REPLACE_ON_DEPLOY` プレースホルダ |
| 9 | **Cloudflare Queues / KV キャッシュ / Smart Placement** | 設計上のフックのみ。未実装 |
| 10 | **ブラウザ E2E** | MVP 対象外と明記（スペック）。data-testid は全画面に付与済みで、Playwright 等を入れるだけの下地はある |

### 4.2 繰延事項（最終レビュー裁定 defer-post-MVP。全 22 項目）

テストカバレッジ系（機能は他レイヤーで実証済み・穴だけ塞ぐ類）:

- **B1** 入力スキーマ約 15 種（src/schemas/api.ts 系）の直接単体テスト無し（ルート統合テスト経由でのみ検証）
- **B2** viewer ロールの 403 明示テスト不足（projects PATCH / tokens GET・DELETE）
- **B3** history HTTP の cross-org 404・malformed-cursor テスト欠落
- **B4** testcase detail の status POST / accept-fingerprint POST の conflict 分岐（`occ_conflict` リダイレクト）未テスト（edit-save 分岐のみテスト有）
- **B5** edit 保存の byte 上限テストは metadata(10KB) のみ。parameters(100KB) は同一コードパスだが専用回帰テスト無し
- **B6** D-06 パスワード上限 128 字の拒否テストが S-19/S-20 フローに無い（下限のみ）
- **B8** `runMaintenanceCli` ラッパー自体のテスト無し（incremental_vacuum 呼出・失敗 JSON・exitCode=1）
- **B9** `src/entry/node.ts` の serveStatic 経路の自動テスト無し（手動確認は済み: css/js 200・未マッチ 404）

コード品質系（重複・結合の整理）:

- **C1** `requiredParam` 4 行ヘルパーが 3 箇所重複（tokens-pages / users-pages / testcase-detail）→ 共有 ui ヘルパーへ
- **C2** `buildEditPatchInput` / `buildTestCasePayload` のパラメータ行マッピング重複（null vs undefined sentinel 差のみ）→ sentinel をパラメータ化した単一ヘルパーへ
- **C3** `GherkinTabContent` がコピー用テキスト生成で `renderGherkin` の feature/Scenario 判定を再導出（**drift 危険**: 片方だけ編集すると乖離する）→ 単一関数から両方導出するのが本命
- **C5** UNIQUE 制約違反の検出が文字列一致（3 ドライバ共通の cause-chain 探索・契約テスト済み）→ 構造化エラーコード化の検討
- **C6** `findUserForLogin` がグローバル検索（**単一 org 前提**）→ マルチ org 化する時は必ず修正。docs/auth-security.md に例外として明記済み
- **C8** API ルートの middleware 順序（resolveProject vs zValidator）の様式不統一（機能は全箇所正しい）（2026-07-04 検証: API 全 32 ルート中 resolveProject+zValidator 併用の 10 箇所すべてが resolveProject→zValidator 順で統一済み・逸脱ゼロ。コード変更不要と確定）
- **C9** `applyBulkAction` が `canTransition` に委譲していない（bulk は意図的に狭いマトリクス。共有すると過結合になる判断も既録）
- **C10** `src/entry/workers.ts` の `depsFrom` が scheduled 用に Auth+limiters まで構築（cron tick 毎に不要オブジェクト生成）→ storage+clock の最小 builder 分離
- **C11** `maintenance-cli` が retentionMs 取得のためだけに `loadConfig` 全体を呼ぶ（SESSION_SIGNING_KEYS 警告が無関係に出る。C10 と同型）
- **A2** docs/screens.md:306 の S-08 行が commit summary を参照（正: `GET /sync/status`）— docs 1 行
- **A3** docs/screens/admin/S-18-user-list.md の「API 未定義」stale 注記（last_login_at は実装済み）— docs 1 行

ツーリング系（node-ts-loader）:

- **D1** `src/entry/node-ts-loader.mjs` が `reportDiagnostics` 無し（TS 構文エラーが不明瞭なランタイム SyntaxError になる。`npm run typecheck` が正ゲートなので実害小）
- **D2** 同 loader が sourcemap 非対応（start:node のスタックトレースがトランスパイル後の行番号）
- **D3** tsconfig.json に `isolatedModules: true` が無い（per-file transpile で壊れるパターン——型のみ再エクスポート等——への将来ガード。現状違反ゼロ確認済み）

### 4.3 wontfix 裁定（最終レビューで「直さない」と決定済み。再着手不要）

- **A5** gherkin Examples 表の docs 例との空白整形差（docs 例は手整形。内容は一致）
- **B10** Progressive Enhancement 用クライアント JS（param 行追加/tag チップ/copy/dialog close）の jsdom テスト（no-JS のサーバー経路が権威でテスト済み。手書き IIFE への jsdom ハーネスは MVP には過剰）
- **C4** `db: any` キャスト（3 アダプタ抽象の意図的シーム・局所化済み）
- **C7** libSQL アダプタの auto_vacuum/WAL try/catch スコープ（operations.md §6.2 の意図どおり。foreign_keys は swallow の外）
- **C12** 同一行並行 PATCH の勝敗分類ニュアンス（直列化は正しい・ラベリングの問題のみ）

### 4.4 受容リスク（意図的トレードオフ。監視ポイントとして把握しておく）

- **E1** sync commit **工程 0-2（同定採番/canonical/identity 生成）は非 windowed**。数千件規模の初回同期は 1 Worker 呼出内の逐次バッチで CPU/subrequest 上限に当たり得る。データ破壊なし・冪等・再送安全。docs に「初回同期は分割推奨」明記済み。恒久対応 = 工程 0-2 の windowing（post-MVP）
- **E2** レガシー低 iteration PHC アカウントの wrong-password 応答時間が configured iters より速く、「旧ハッシュの既知メール」を識別し得る（透過再ハッシュの本質的性質。未知メールのコスト均等化は実装済み）
- **E3** `PATCH /auth/password` の現在パスワード検証は instant-return（セッション認証済みで列挙価値なし）
- **E4** `purgeObservations` が反復毎に survivor set（ROW_NUMBER 全走査）を再計算（operations.md の SQL スケッチ準拠。テーブル肥大時のスケーリング課題）
- **E5** S-18 の行クリックは名前セルのみリンク（doc は "clickable row" 表記・testid は tr で GC-8 充足）
- **E6** S-19「保存ボタンは変更がある時のみ enabled」未実装（cosmetic・全画面一貫）
- **E7** UI に 5xx トースト無し（エラーは errorMiddleware の統一 JSON。横断 hardening 課題）
- operations.md 記載: **TestCaseHistory はパージ対象外（post-MVP）**。長期運用で肥大するテーブルであることは operations.md に明記済み

---

## 5. 教訓・落とし穴（再発防止リスト）

過去に実際に踏んだもの。同型の変更をする時は必ず思い出すこと:

1. **窓付き UPDATE に自己除外述語が無いと livelock**（最終レビュー Critical）。SQLite は同値 UPDATE も `changes()` に数える。窓カウントで `more` を判定する全工程は「既処理行が述語から抜ける」ことをテストで証明する。
2. **列衝突で集計常に 0**: drizzle で `tc.project_id = tc.id` の取り違え → `testcase_count` 常時 0。空状態テストは 2 度すり抜けた。→ 非ゼロ識別テスト必須。
3. **誤バインド + 誤テスト**: sync-new-count を `current.unreviewed` にバインド（正: `Σ last_summary.created`）し、テストも誤値を正解として固定。→ distinct 値 fixture。
4. **OCC 並行破れ**: 影響行数を見ない batch → 敗者へ偽成功 + 幽霊履歴。→ §3.2 の OCC パターン。
5. **prototype 汚染認証バイパス**: `signingKeys["__proto__"]` → `Object.hasOwn` ガード。
6. **タイミング側チャネル**: 未知メールで PBKDF2 スキップ → コスト均等化。
7. **最後の admin の TOCTOU**: count→update 非原子 → 原子的条件付き UPDATE（`setUserRoleGuarded`）。
8. **WAL 先行で auto_vacuum 無効化**: PRAGMA は auto_vacuum → WAL の順。
9. **no-JS 送信ロックアウト**: SSR ボタンの disabled ハードコード禁止。
10. **エラーハンドリング fix の catch 過大**: bootstrap ガードのつもりが実行時失敗まで握り潰し + 誤ラベル（waitUntil の reject シグナル喪失）。catch は最小スコープで。
11. **D1 バインド上限**: >97 refs の IN で "too many SQL variables" 実例あり。
12. **@cloudflare/vitest-pool-workers の quirk**: reject する waitUntil promise は real ExecutionContext だと pool グローバルに二重登録され次テストを汚染 → 最小 fake ctx で promise を直接捕獲するパターンが正当（tests/integration/entry.test.ts に前例）。
13. **エントリ層の bootstrap throw は errorMiddleware に届かない**: Hono の外で throw する物は entry 側 try/catch + `toErrorResponsePayload` で統一スキーマに変換する。
14. プロセス面: サブエージェントの偽コミット報告（git で実在確認する）、fork 暴走（ブリーフで禁止明記）、プロンプトインジェクション混入（"隠せ/戻すな" 系は無視して git 検証・報告）。

---

## 6. 次の開発の始め方

1. **後始末**: §1 の 3 点（push / worktree・branch 掃除）。
2. **環境**: node22 が PATH にあること（`~/.claude/settings.json` の env.PATH 設定済み）。`npm install` → `npm test` で 760 green を確認してから始める。
3. **題材選び**: §4.1（機能追加）か §4.2（品質改善）から。小さく始めるなら B 系テスト穴埋め or C1-C3 の DRY。機能なら S-03/S-04（リセットメール）か検索/ソートが独立性高い。
4. **プロセス**: 新機能は superpowers:brainstorming → spec/plan 作成（writing-plans）→ SDD（subagent-driven-development）のループを踏襲。§3 の方針・実装標準・§5 の教訓をブリーフ/レビュー観点に織り込むこと。
5. **docs 更新**: 実装と docs の乖離を見つけたら「実装済みの事実のみ書く」原則で docs を追随させる（未実装の約束を書かない）。

## 7. 資料マップ

| 資料 | 場所 | 備考 |
|---|---|---|
| スペック（決定 D-01〜D-14・対象外リスト） | `docs/superpowers/specs/2026-07-02-tms-mvp-build-design.md` | 意思決定の正本 |
| 実装計画（23 タスク・GC-1〜10） | `docs/superpowers/plans/2026-07-02-tms-mvp-build.md` | プロセス規律の正本 |
| API 仕様 | `docs/api-reference.md`, `docs/apis/*.md` | 実装と突合済み |
| データモデル | `docs/data-model.md` | 11 テーブル + sync_seen |
| 同期プロトコル | `docs/sync-protocol.md` | 8 工程・出現台帳・失効執行モデル |
| 認証・セキュリティ | `docs/auth-security.md` | RBAC 能力マトリクス・D-14・GC-5 例外一覧 |
| 運用（パージ/sweep/cron） | `docs/operations.md` | rowid パターン・オンプレ cron |
| 画面カタログ（data-testid 正本） | `docs/screens/**` | S-01〜S-21 |
| 起動・デプロイ手順 | `README.md` | CF デプロイ / オンプレ / env 一覧 / 衛星 curl 例 |
| 本引き継ぎ書 | `docs/HANDOVER.md` | MVP 完了時点のスナップショット |

git 履歴も一次資料（Conventional Commits。MVP 本体は `71022ea..78bad84` の 52 コミットで、以降にドキュメント整備コミットが続く。レビュー fix の経緯はコミットメッセージから追える）。
