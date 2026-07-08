# TMS 開発引き継ぎ書 — 品質スプリント完了時点（更新: 2026-07-04）

> 対象読者: 次の開発サイクルを始める開発者。
> この 1 枚で「現在地・後始末・開発方針・未実装の全量」が分かることを目的とする。この 1 枚は生きた正本であり、開発サイクルごとに現在地まで前進させる（別ファイルを増やして drift させない）。
> 履歴: MVP 完了（2026-07-03、main=`78bad84`）→ **post-MVP 品質スプリント完了（2026-07-04、main=`b664e85`）**。
> 正本の所在: 仕様の決定は `docs/superpowers/specs/2026-07-02-tms-mvp-build-design.md`（D-01〜D-14）、MVP 実装計画は `docs/superpowers/plans/2026-07-02-tms-mvp-build.md`（23 タスク + GC-1〜GC-10）、品質スプリント計画は `docs/superpowers/plans/2026-07-04-post-mvp-quality-sprint.md`（17 タスク）。docs/ は実装と突合済み（「実装済みの事実のみ」記載の原則）。

---

## 1. 現在地（TL;DR）

- **MVP + post-MVP 品質スプリント完成。main = `b664e85`（2026-07-04、fast-forward マージ済み）。** MVP 本体は `78bad84`、品質スプリントは `9169b26..b664e85` の 19 コミット。最新 SHA は `git log` を正とする。
- **815 テスト green**（unit 416 / workers 統合 399）、typecheck 0 エラー。MVP 時点の 760（376/384）から品質スプリントで +55。
- 品質スプリントの成果: 最終レビュー裁定の繰延バックログ（§4.2）を消化 — テスト穴埋め B1-B6/B8/B9、DRY リファクタ C1-C3、maintenance 結合分離 C10/C11、docs A2/A3、ツーリング D1-D3。C8 は検証の結果「変更不要」と確定。C5/C6/C9 のみ意図的据え置き。独立レビュアーのコードレビューは Critical/Important 0。
- E2E 実証済み（MVP 時）: `wrangler dev` curl ウォークスルー（セットアップ→ログイン→プロジェクト→トークン発行→sync start/chunk/commit→status→approve）、Node エントリ起動 smoke（`/login`・静的配信・404）。
- MVP 最終レビューで捕捉した Critical 1 件（sync commit 工程 6 の drift 収束ガード欠落 = 同期恒久ハング）は `ba83f44` で修正・回帰テスト済み。

### 未完の後始末（最初にやること）

1. **origin へ未 push**。開発環境の権限分類器が「main への直接 push」をブロックするため Claude からは実行不可。開発者がお手元で `git push origin main` を実行する（`b664e85` まで publish）。
2. worktree `/workspace/.claude/worktrees/tms-mvp-build` とブランチ `worktree-tms-mvp-build` が残置（ハーネス管理・`.claude/worktrees/` 配下）。掃除する場合は worktree 削除後に `git branch -d worktree-tms-mvp-build`（完全マージ済みなので安全に通る）。
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
| maintenance の設定独立（C10/C11） | maintenance 系エントリ（workers `scheduled` の `depsFrom` / `maintenance-cli`）は **署名鍵設定（SESSION_SIGNING_KEYS）を読まない**。retention は `loadMaintenanceRetentionMs`（`src/http/config.ts`）だけで解決する。不正な署名鍵でも cron/CLI は走る（＝設定不備が全 HTTP と cron を同時に殺さない）。**これは意図的挙動なので `loadConfig` へ戻さないこと**。fetch パスは従来どおり `loadConfig` 経由で GC-4 bootstrap 失敗を返す |

### 3.3 環境メモ

- node v22 必須（`~/node22/bin`。better-sqlite3 は node22 ABI でビルド済み。当時の開発環境は既定 node が v18 だったため全コマンドに `export PATH="$HOME/node22/bin:$PATH" &&` を前置していた）。
- `npm run dev` = wrangler dev。postinstall が htmx を `public/` にコピー。
- オンプレ: `npm run start:node`（`TMS_DB_PATH`・`PORT`）、`npm run maintenance:node`（OS cron 例は README）。env 一覧と `SESSION_SIGNING_KEYS`/`SESSION_ACTIVE_KEY_ID` の規約は README + `docs/auth-security.md`。
- テスト用 wrangler 互換日付は installed workerd の上限（2025-09-06）警告が出るが無害。
- `start:node` / `maintenance:node` は `--enable-source-maps` 付き（D2）。`node-ts-loader.mjs` は inline sourcemap を埋め込み、transpile 診断を明示報告する（D1。TS 構文エラーは不明瞭な SyntaxError でなく `node-ts-loader: TypeScript transpile diagnostics ...` で落ちる）。`maintenance:node` は署名鍵設定を要求しない（cron 例は README。必要 env は `TMS_DB_PATH` と `OBSERVATION_RETENTION_MS` のみ）。

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

> **消化状況（品質スプリント 2026-07-04、計画 = `plans/2026-07-04-post-mvp-quality-sprint.md`）:** 22 項目中 **18 実装済み [済] + C8 検証 no-op [済] = 19 完了**、**残るは C5・C6・C9 の 3 項目 [据置]**（いずれも「今直すと過結合/対象外」の既録判断。C6 のみマルチ org 化に着手する時は必須修正）。各項目の状態を行頭に付す。実装の回帰テストはすべて green（テスト 760→815）。

テストカバレッジ系（機能は他レイヤーで実証済み・穴だけ塞ぐ類）:

- **[済] B1** 入力スキーマの直接単体テスト無し → api/limits/entities/sync の未テスト全スキーマ（~22 種）を `tests/unit/schemas.test.ts` に追加（±1 byte 境界の自己検証つき）
- **[済] B2** viewer ロールの 403 明示テスト不足 → projects PATCH / tokens GET・DELETE に viewer 403 + 無変更の識別テスト追加
- **[済] B3** history HTTP の cross-org 404・malformed-cursor テスト欠落 → 両方追加（不正 cursor は 422 でなく先頭ページへフォールバック = domain/cursor の decode-null 仕様を固定）
- **[済] B4** testcase detail の status POST / accept-fingerprint POST の conflict 分岐（`occ_conflict` リダイレクト）未テスト → 両分岐を追加（サボタージュ検証済み）
- **[済] B5** parameters(100KB) の専用回帰テスト無し → 超過拒否 + 上限内保存の境界両側を追加
- **[済] B6** D-06 パスワード上限 128 字の拒否テストが S-19/S-20 に無い → API 2（reset/PATCH password）+ UI 3（S-19 reset・create、S-20 profile）追加
- **[済] B8** `runMaintenanceCli` ラッパー未テスト → `maintenanceCliMain` を export 抽出し incremental_vacuum 発行・失敗 JSON・exitCode=1 をテスト
- **[済] B9** `src/entry/node.ts` の serveStatic 経路の自動テスト無し → app.css/htmx.min.js 200 + 未マッチ 404（GC-4 スキーマ）を `tests/unit/node-entry.test.ts` に追加

コード品質系（重複・結合の整理）:

- **[済] C1** `requiredParam` 4 行ヘルパーが 3 箇所重複 → `src/http/ui/params.ts` に共有化 + 直接単体テスト
- **[済] C2** `buildEditPatchInput` / `buildTestCasePayload` のパラメータ行マッピング重複 → `buildTestCaseFields<A extends null|undefined>`（absent 哨兵をパラメータ化）に統一。create=undefined / patch=null のラッパー化
- **[済] C3** `GherkinTabContent` がコピー用テキストで `renderGherkin` の判定を再導出（drift 危険） → `buildGherkinLines`（`src/domain/gherkin.ts`）で DOM とコピー文の両方を単一導出。drift を構造的に排除 + data-raw ガードテスト
- **[据置] C5** UNIQUE 制約違反の検出が文字列一致（3 ドライバ共通の cause-chain 探索・契約テスト済み）→ 構造化エラーコード化の検討。**着手不要（意図的シーム）**
- **[据置] C6** `findUserForLogin` がグローバル検索（**単一 org 前提**）→ **マルチ org 化する時は必ず修正**。docs/auth-security.md に例外として明記済み
- **[済] C8** API ルートの middleware 順序（resolveProject vs zValidator）の様式不統一 → 2026-07-04 検証: 併用する API ルート 10 箇所すべてが resolveProject→zValidator 順・逆順ゼロ。**コード変更不要と確定（no-op）**
- **[据置] C9** `applyBulkAction` が `canTransition` に委譲していない（bulk は意図的に狭いマトリクス。共有すると過結合）。**着手不要（意図的判断）**
- **[済] C10** `depsFrom` が scheduled 用に Auth+limiters まで構築 → storage+clock+retention の最小 builder に分離。§3.2「maintenance の設定独立」参照（意図的挙動変更）
- **[済] C11** `maintenance-cli` が retentionMs のためだけに `loadConfig` 全体を呼ぶ → `loadMaintenanceRetentionMs` へ切替。SESSION_SIGNING_KEYS 警告が消えた
- **[済] A2** docs/screens.md の S-08 行が commit summary を参照 → `GET /sync/status` の `last_summary` に修正
- **[済] A3** docs/screens/admin/S-18-user-list.md の「API 未定義」stale 注記 → last_login_at 実装済みの事実に更新

ツーリング系（node-ts-loader）:

- **[済] D1** `node-ts-loader.mjs` が `reportDiagnostics` 無し → 追加。TS 構文エラーは `node-ts-loader: TypeScript transpile diagnostics ...` で明示的に落ちる + spawn スモークテスト
- **[済] D2** 同 loader が sourcemap 非対応 → inline sourcemap 埋め込み + `start:node`/`maintenance:node` に `--enable-source-maps`。スタックが .ts の元行番号で出る
- **[済] D3** tsconfig.json に `isolatedModules: true` が無い → 追加（現状違反ゼロ確認済み。per-file transpile への将来ガード）

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

1. **後始末**: §1「未完の後始末」（push は開発者が実行 / worktree・branch 掃除はハーネス管理 / sdd 台帳は本書が恒久版）。
2. **環境**: node22 が PATH にあること（`~/.claude/settings.json` の env.PATH 設定済み）。`npm install` → `npm test` で **815 green** を確認してから始める。
3. **題材選び**: §4.1（機能追加）が主戦場になった — §4.2 の品質バックログは C5/C6/C9 の 3 据え置きを除き消化済み。機能なら S-03/S-04（リセットメール = メール可搬境界の新設）か検索/ソート（§4.1-4、カーソルページングとの整合設計）が独立性高い。品質面で残すのは C6（マルチ org 化に着手する時に必須）。
4. **プロセス**: 新機能は superpowers:brainstorming → spec/plan 作成（writing-plans）→ SDD（subagent-driven-development）または executing-plans のループを踏襲。§3 の方針・実装標準（特に「maintenance の設定独立」を巻き戻さない）・§5 の教訓をブリーフ/レビュー観点に織り込むこと。
5. **docs 更新**: 実装と docs の乖離を見つけたら「実装済みの事実のみ書く」原則で docs を追随させる（未実装の約束を書かない）。本書は開発サイクルごとに §1 現在地まで前進させる。

## 7. 資料マップ

| 資料 | 場所 | 備考 |
|---|---|---|
| スペック（決定 D-01〜D-14・対象外リスト） | `docs/superpowers/specs/2026-07-02-tms-mvp-build-design.md` | 意思決定の正本 |
| MVP 実装計画（23 タスク・GC-1〜10） | `docs/superpowers/plans/2026-07-02-tms-mvp-build.md` | プロセス規律の正本 |
| 品質スプリント計画（17 タスク） | `docs/superpowers/plans/2026-07-04-post-mvp-quality-sprint.md` | §4.2 消化の計画・各タスクの diff とテスト方針 |
| API 仕様 | `docs/api-reference.md`, `docs/apis/*.md` | 実装と突合済み |
| データモデル | `docs/data-model.md` | 11 テーブル + sync_seen |
| 同期プロトコル | `docs/sync-protocol.md` | 8 工程・出現台帳・失効執行モデル |
| 認証・セキュリティ | `docs/auth-security.md` | RBAC 能力マトリクス・D-14・GC-5 例外一覧 |
| 運用（パージ/sweep/cron） | `docs/operations.md` | rowid パターン・オンプレ cron |
| 画面カタログ（data-testid 正本） | `docs/screens/**` | S-01〜S-21 |
| 起動・デプロイ手順 | `README.md` | CF デプロイ / オンプレ / env 一覧 / 衛星 curl 例 |
| 本引き継ぎ書 | `docs/HANDOVER.md` | 現在地までの生きた正本（サイクルごとに前進） |

git 履歴も一次資料（Conventional Commits。MVP 本体は `71022ea..78bad84` の 52 コミット、品質スプリントは `9169b26..b664e85` の 19 コミット。レビュー fix の経緯はコミットメッセージから追える）。
