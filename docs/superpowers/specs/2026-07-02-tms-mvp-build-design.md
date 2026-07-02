# TMS Web Service MVP 構築設計

日付: 2026-07-02
ステータス: 承認済み(ユーザー確認済み)

## 目的

docs/ 配下の設計ドキュメント一式(architecture / data-model / api-reference / apis/* / sync-protocol / auth-security / operations / usecase / screens / screens/*)に基づき、TMS Web Service の MVP を実装する。本スペックは既存設計の**繰り返しではなく**、(1) 構築スコープの確定、(2) 精査で発見した未定義・矛盾箇所の解決、(3) 実装アーキテクチャの確定、を記録する。エンティティ定義・API 詳細・画面仕様は既存ドキュメントを正とする。

## スコープ

### 実装対象

- **画面(17)**: S-01, S-02, S-06〜S-20(グローバルヘッダー・プロジェクトコンテキストヘッダー・パンくず・トースト含む)
- **API**: docs/apis/ の全定義済みエンドポイント + 同期プロトコル(start/chunk/commit) + 本スペックで新設する `GET /api/v1/projects/:pid/sync/status`
- **認証・セキュリティ**: セッション認証、API トークン認証、RBAC、CSRF、テナント境界/IDOR 防止、レートリミット
- **運用**: Cron(観測パージ・失効 sweep・SyncStaging パージ・行数概算ログ)、Drizzle マイグレーション、README(デプロイ/起動手順)
- **実行基盤**: Cloudflare Workers エントリ(主軸)+ Node オンプレエントリ。Storage は D1 / better-sqlite3 / libSQL の3アダプタを契約テストで検証

### 対象外(MVP 後)

- S-03/S-04 セルフサービスパスワードリセット(メール基盤が必要。管理者手動リセットで代替)
- S-05 ダッシュボード、S-21 レポート/CSV エクスポート(集計 API 未定義のまま据え置き)
- フリーテキスト検索、テーブルソート、Gherkin エクスポートボタン(表示タブは対象)
- re-adopt API(human→machine 復帰。data-model.md に記述はあるが MVP 後と決定)
- ユーザー無効化、テストレベル分類、コメント/メモ、招待メール
- 実環境への `wrangler deploy`(手順書のみ整備)
- Cloudflare Queues / KV キャッシュ / Smart Placement 等のオプション最適化(設計上のフックのみ)

## 決定事項

精査で発見した未定義・矛盾箇所と、ユーザー確認済みの解決策。

### D-01 同期サマリー API(G-08 の完結)

S-08 の同期サマリーパネルにバッキング API が存在しなかった(commit レスポンスは衛星にしか返らない)。

- `SyncSession` に集計列を追加: `committed_at INTEGER?`, `created_count INTEGER?`, `changed_count INTEGER?`, `staled_count INTEGER?`
- commit の工程8(セッション確定)と同一バッチで COUNT 集合文により算出・保存する。全て既存テーブルから再計算可能な純関数であり、mid-commit 再開でも冪等
  - `created_count` = 当該 token の SyncStaging 行数(新規 canonical 数)
  - `changed_count` = 当該 token の TestCaseObservation の DISTINCT external_ref 数(変化点が記録されたケース数)
  - `staled_count` = 当該 (project, origin) で `last_seen_sync_token != token` の identity 数
- 新設 API: **`GET /api/v1/projects/:pid/sync/status`**(viewer 以上。セッション Cookie / API トークン両対応)

```json
{
  "origins": [
    {
      "origin": "discovery-v1",
      "last_committed_at": 1719392400000,
      "last_summary": { "created": 12, "changed": 3, "staled": 4 }
    }
  ],
  "current": { "unreviewed": 28, "drift": 3, "stale": 4 }
}
```

- `origins` は origin 別の最新 committed セッション。committed セッションが無い origin は含めない
- `current.unreviewed` = `status=draft AND ownership=machine` 件数、`drift` = `drift=true` 件数、`stale` = `is_stale=true` 件数(いずれも非 archived)
- S-08 パネルへの対応: 「新規 N 件」= `last_summary.created`、「drift / stale 件数」= `current`、「最終同期日時」= `last_committed_at`。`changed_count` はパネル必須ではない参考値(新規ケースも変化点として含む)

### D-02 アーカイブ経路の統一

UI は `PATCH {status:"archived"}`、API 仕様には `DELETE` も定義されており食い違っていた。

- **PATCH(status 変更)を正経路**とし、`DELETE /testcases/:id` は同一ドメイン操作(アーカイブ)を呼ぶ**セマンティックエイリアス**として両方実装する
- DELETE は OCC 不要・冪等(既に archived なら現状を返す)。仕様の位置づけを apis/testcases.md に追記する

### D-03 ページング UI と件数

API はカーソルベース(前方のみ)だが S-08 には「前へ」ボタンと件数表示があった。

- テストケース一覧 API は**正確な `total`**(フィルタ適用後件数)を返す。MVP 規模(数千件)では COUNT は十分高速
- ページングは cursor を URL クエリに載せ `hx-push-url` で同期。「前へ」は**ブラウザ履歴**で実現し、UI には「次へ」「先頭に戻る」のみ配置する(S-08 の `btn-prev` は廃止)

### D-04 履歴 actor の表示名解決

ユーザー参照 API は admin 限定のため、viewer/editor は `user:<uuid>` を解決できなかった。

- 履歴 API の各アイテムに任意フィールド **`actor_display`**(例: `"田中太郎"` / `"discovery-ci"`)を追加。読み出し時に User / ApiToken を JOIN して解決する。削除済み等で解決不能なら `actor` の生値をそのまま入れる。任意フィールド追加なので非破壊

### D-05 API 応答の追加フィールド

- **`updated_at` の意味論**: テストケース API 応答の `updated_at = max(human_updated_at, system_updated_at)` と定義(DB 列は分離のまま。他エンティティは単一の `updated_at` 列をそのまま返す)
- **`GET /api/v1/projects`**: 各アイテムに `testcase_count`(非 archived のテストケース件数)を追加
- **`GET /api/v1/users`**: 各アイテムに `last_login_at`(null 可)を追加。**User テーブルに `last_login_at INTEGER?` 列を追加**し、ログイン成功時に更新する

### D-06 パスワードポリシー

最小 8 文字・最大 128 文字。複雑性要件なし(NIST SP 800-63B 準拠。防御はレートリミット + PBKDF2 600k が担う)。共有 Zod スキーマ 1 箇所で定義し、S-01/S-19/S-20 と全 API が同一検証を用いる。

### D-07 入力フィールド最大長(Zod 正本)

| フィールド | 最大長 |
|---|---|
| 組織名・表示名・プロジェクト名・トークン名 | 100 文字 |
| メールアドレス | 254 文字(+ email 形式) |
| テストケースタイトル | 200 文字 |
| target | 512 文字 |
| given / when / then | 各 10,000 文字 |
| parameters(JSON 直列化後) | 100 KB |
| metadata(JSON 直列化後) | 10 KB |
| observed 全体(同期観測 1 件) | 256 KB |
| repo_url | 2,000 文字(http/https URL 形式) |

すべて `src/schemas/` の共有 Zod スキーマで一元定義し、UI・API 両方で同一検証を行う。

### D-08 セッション TTL

7 日固定(スライディング延長なし)。環境変数 `SESSION_TTL_MS` で変更可能。

### D-09 CSRF 実装方式

HttpOnly Cookie + サーバー埋込型 double-submit。

- セッション発行時に 32B ランダムの CSRF トークンを `HttpOnly; Secure; SameSite=Lax` Cookie で配布
- SSR が全フォームの hidden input と `<body hx-headers='{"X-CSRF-Token": ...}'>` に同一値を埋め込む
- ミドルウェアが POST/PATCH/DELETE で Cookie 値と送信値の一致を検証。不一致は 403
- Bearer トークン認証のリクエスト(衛星)は Cookie を使わないため CSRF 検証対象外

### D-10 Idempotency-Key

ヘッダは受理するがメモ化ストアは持たない(構造的冪等性に依存)。再送時に chunk の `outcome` が `inserted`→`duplicate` に変わるのは意味論的に等価。api-reference.md の「短期メモ化」記述は「将来の多重防御オプション」に改める。

### D-11 認証失敗監査

構造化 JSON ログ(console)のみ。CF は Workers Logs / Logpush、オンプレは標準出力の収集基盤で監査する。D1 テーブル追加は将来拡張。ブルートフォース防御のカウンタは RateLimiter インターフェースで実装する(D-14)。

### D-12 re-adopt は MVP 後

data-model.md の re-adopt(human→machine 復帰)は MVP では実装しない。data-model.md に `[※MVP後]` を追記する。

### D-13 軽微な解決(8 点)

1. ログイン後の遷移先は **S-06 プロジェクト一覧**(S-05 は MVP 後)
2. S-02 の「パスワードを忘れた場合」リンクは非表示。「パスワードを忘れた場合は管理者にお問い合わせください」のヒント文言のみ
3. S-09 のボタンは「作成」1 つに統合(status=draft 固定。API は仕様どおり status 受理可のまま)
4. S-12 の Diff タブは drift=false でも常時クリック可能。canonical のみ +「差分はありません」を表示
5. リダイレクト時のメッセージ伝搬は `?flash=` クエリ方式(例: `/login?flash=session_expired`)
6. `GET /testcases/:id/observations` は UI 未使用でも仕様どおり実装(衛星・デバッグ用途)
7. **「最後の admin」保護**: 組織の admin が 0 人になる role 変更を API 側で 422 拒否
8. セットアップ誘導は SSR ルート内部で Organization 存在チェックしてリダイレクト(公開 API 新設なし)

### D-14 レートリミット具体値

- ログイン: `(email, IP)` キーで **5 失敗 / 15 分** → 429 + `Retry-After`
- 衛星トークン: トークン別 **120 リクエスト / 分**
- 実装: `RateLimiter` インターフェース(CF: Workers Rate Limiting binding、オンプレ/dev: インメモリ)。best-effort・eventually consistent の位置づけは auth-security.md どおり

## アーキテクチャ

### リポジトリ構造(単一パッケージ・2 エントリ)

```
src/
├── schemas/        # Zod 正本: エンティティ・API 入出力・enum・D-06/D-07 の制限値
├── domain/         # 純粋ロジック(HTTP も DB も知らない)
│                    #   状態遷移ガード、ownership 遷移、Gherkin 描画、diff 計算、
│                    #   commit パイプライン組み立て、履歴 delta 生成
├── storage/
│   ├── schema.ts   # Drizzle テーブル定義(SQLite 方言・3 アダプタ共通)
│   ├── interface.ts# Storage インターフェース(全メソッド orgScope 必須)
│   └── adapters/   # d1.ts / better-sqlite3.ts / libsql.ts
├── auth/           # Auth インターフェース: PBKDF2(PHC)・セッション署名・トークンハッシュ
├── ratelimit/      # RateLimiter インターフェース: binding / インメモリ
├── http/
│   ├── middleware/ # 認証(三段AND)・RBAC・スコープ解決(IDOR)・CSRF・統一エラー
│   ├── api/        # /api/v1 JSON ルート
│   └── ui/         # SSR ルート(Hono JSX)+ HTMX フラグメント
├── entry/
│   ├── workers.ts  # CF: fetch + scheduled(Cron)
│   └── node.ts     # @hono/node-server + better-sqlite3 + メンテナンス CLI
└── static/         # htmx.min.js(自己ホスト)・app.css(自前クラスレス CSS)
tests/
├── unit/           # ドメイン層(モック Storage)
├── contract/       # Storage 3 アダプタ共通スイート(UPDATE/DELETE...LIMIT 互換含む)
└── integration/    # workers pool: API 全編・同期プロトコル・SSR スモーク
```

- 依存方向は `http → domain → storage(interface)` の一方向。CF 固有バインディングは adapters と entry/workers.ts のみ
- D1 はインタラクティブトランザクション非対応のため、Storage インターフェースは「操作単位」で切り、アダプタ内部で `batch()`(D1/libSQL)またはトランザクション(better-sqlite3)を用いる
- `when` / `then` は SQL キーワードだが、Drizzle は識別子を引用符付けするため列名はドキュメントどおり

### データベース

data-model.md の 11 テーブル・全インデックス・CHECK 制約(enum 二重防御、`status IN ('approved','archived') ⇒ ownership='human'` 複合 CHECK、部分一意索引 `uq_active_session`)をそのまま実装する。本スペックによる差分は D-01(SyncSession 集計列)と D-05(User.last_login_at)のみ。

### UI 実装

- Hono JSX SSR + HTMX(自己ホスト 1 ファイル)。最小 JS 方針。docs/screens/ の各画面仕様(ワイヤーフレーム・data-testid・状態バリエーション・エラー状態)に準拠し、全要素に定義済み data-testid を付与する
- UI ルートはドメイン層を直接呼ぶ(内部 HTTP 往復なし)
- HTMX 部分更新: テストケース一覧のフィルタ/ページング/一括操作、詳細画面タブ、各ダイアログ。フォームは通常 POST + PRG、HTMX はフラグメント応答
- CSS は自前クラスレス 1 ファイル。バッジ・Diff 行・トースト等の視覚要素を含む

### Cron・運用

- CF: Cron Triggers(1 時間毎)の `scheduled()` で ①観測パージ(90 日・per-origin 最低 1 件保持・committed のみ・`DELETE...LIMIT` 小バッチ・1 実行 1,000 クエリ未満)②期限切れセッション sweep(SyncSession・UI Session)③committed/expired の SyncStaging パージ ④主要テーブル行数の概算ログ
- オンプレ: 同一操作を `node dist/maintenance.js` として公開し OS cron から実行。接続初期化フックで `PRAGMA auto_vacuum=INCREMENTAL` + `journal_mode=WAL`、パージ後 `incremental_vacuum`
- マイグレーション: Drizzle Kit 単一ソース → `wrangler d1 migrations apply`(CF)/ Drizzle migrator(オンプレ)

## テスト戦略(TDD 前提)

| レイヤ | ツール | 対象 |
|---|---|---|
| ドメイン単体 | Vitest(node pool) | 状態遷移ガード・ownership 遷移・diff/Gherkin 導出・delta 生成 |
| Storage 契約 | Vitest 共通スイート | D1(workers pool)/ better-sqlite3 / libSQL に同一スイート。`UPDATE/DELETE...LIMIT` 互換チェック必須 |
| 統合 | @cloudflare/vitest-pool-workers | API 全編(認証・RBAC・OCC・テナント境界・エラーコード)、同期プロトコル(冪等再送・mid-commit 再開・stale/drift/mirror シナリオ)、SSR スモーク(data-testid 存在確認) |

ブラウザ E2E は MVP 対象外(data-testid は全画面に付与済みで将来資産とする)。

## 既存ドキュメントへの反映

実装と同時に以下を docs/ に反映する(実装計画にタスクとして含める):

1. apis/ に sync/status(D-01)・DELETE エイリアス位置づけ(D-02)・total(D-03)・actor_display(D-04)・testcase_count / last_login_at / updated_at 意味論(D-05)を追記
2. data-model.md: SyncSession 集計列・User.last_login_at 追加、re-adopt に `[※MVP後]`(D-12)
3. api-reference.md: Idempotency-Key の記述修正(D-10)
4. auth-security.md: パスワードポリシー(D-06)・セッション TTL(D-08)・CSRF 方式(D-09)・レートリミット具体値(D-14)・認証監査の記録先(D-11)を確定値で追記
5. screens: S-08 の「前へ」廃止(D-03)、S-02 リンク非表示・S-09 ボタン統合・S-12 タブ挙動(D-13)

## 成功基準

1. 全テスト(単体・契約 ×3 アダプタ・統合)がグリーン
2. `wrangler dev` でセットアップ → ログイン → プロジェクト作成 → トークン発行 → 同期(start/chunk/commit を curl で模擬)→ レビュー/承認 → drift/stale 確認の一連のユースケース(UC-02〜UC-16 相当)が手元で通る
3. Node エントリ(better-sqlite3)でも同一アプリが起動し、スモークが通る
4. README の手順のみで第三者が CF デプロイ/オンプレ起動できる
