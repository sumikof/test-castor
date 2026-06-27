# TMS Web Service 設計書

- **作成日:** 2026-06-26
- **対象:** Agentic QA TMS プラットフォームの第1サブプロジェクト「TMS Web Service（ハブ）」
- **ステータス:** 設計確定（実装計画フェーズへ）

---

## 1. 背景とスコープ

### 1.1. プラットフォーム全体像（俯瞰）

最終的な目標は「既存コードからの仕様抽出」と「AIによるテストコードの自律生成・管理」を統合した Agentic QA プラットフォーム（長期的にはマルチテナントSaaS）である。これは4つの独立したサブシステムから構成される：

1. **Test Case Discovery** — コード解析による仕様抽出（衛星サービス）
2. **Test Case Management (TMS)** — 構造化テストケースの管理・仕様マスター（★本設計の対象 = ハブ）
3. **Agentic Test Generation** — 承認仕様からのテストコード生成（衛星サービス）
4. **Self-Healing** — CI連携によるテスト破損の自動修復（衛星サービス）

### 1.2. アーキテクチャ方針：ハブ＆サテライト

TMS を「信頼できる唯一の仕様マスター（ハブ）」として独立した単純なWebサービスとして構築する。Discovery／Test Generation／Self-Healing は、すべて TMS の公開APIを叩く疎結合な「衛星サービス」とする。これにより：

- TMS本体から LLM／コード解析の複雑さを完全に排除し、枯れた技術で作れる普通のCRUD Webサービスにできる。
- 各機能を独立して開発・デプロイできる。
- 構造化テストケースのデータモデルが、全衛星サービスの統一契約となる。

```
                         ┌──────────── TMS Web Service（本設計の対象）─────────┐
                         │                                                      │
[ブラウザ:素朴UI] ──────▶│  Hono アプリ（TypeScript / ランタイム非依存）        │
                         │   ├─ UI層: Hono JSX（一覧・編集フォーム）            │
[衛星サービス] ──JSON──▶ │   ├─ API層: REST（/api/...）取り込み・参照          │
 (将来:Discovery等)      │   ├─ ドメイン層: テストケース/プロジェクト/履歴      │
                         │   └─ Storage インターフェース ◀── ★ポータビリティ境界│
                         │            │                                         │
                         │     ┌──────┴───────┐                                 │
                         │   [D1アダプタ]  [libSQLアダプタ]  …                  │
                         └──────┼──────────────┼────────────────────────────────┘
                            (Cloudflare)     (オンプレ)
                              D1/SQLite     libSQL or better-sqlite3
```

### 1.3. 本設計のスコープ

**対象:** TMS Web Service 単体（ハブ）。
**対象外:** Discovery／Test Generation／Self-Healing の中身。本設計では衛星サービス向けの「取り込みAPIの口」のみ定義する。

---

## 2. 主要な意思決定（確定事項）

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| 1 | 成果物のゴール | 汎用SaaS（C）を見据えつつ、最初の解析対象はJava/JUnit単体テストに限定 | 多言語抽象化に溺れず縦に1本通す |
| 2 | 最初に作るサブシステム | TMS Web Service（ハブ） | 全衛星の契約となるデータモデルを先に固める |
| 3 | コード解析方式（Discovery） | 当面は純LLM方式（A）、将来は静的解析グラウンディング（B）。**ただしDiscoveryは別サービスで本設計の対象外** | 解析の複雑さをTMSに持ち込まない |
| 4 | テストケースの保持形式 | 構造化スキーマ。Gherkin/自然言語は派生ビュー | 双方向トレーサビリティ・差分比較・自己修復はすべて構造化前提 |
| 5 | TMS MVP範囲 | ①CRUD ②取り込みAPI ④簡易履歴 ⑤最小認証 ⑥素朴UI。**③HITL承認ワークフローは初版対象外**（statusはデータとしては保持） | シンプルさ優先。③は後続で無改造追加できる設計にする |
| 6 | 実行基盤 | Cloudflare サーバーレス（Workers） | 利用者指定 |
| 7 | 技術スタック | Cloudflare Workers + Hono + D1 + Drizzle ORM + Zod + Hono JSX(SSR) | サーバーレスでシンプルなCRUD＋API＋UIを1アプリで完結 |
| 8 | オンプレ移植性 | 第一級要件（A）。CF固有機能はアダプタ裏に隔離、SQLite方言で統一、認証はポータブル実装 | クラウド/オンプレ差分を「起動エントリ＋DBドライバ＋設定」のみに抑える |
| 9 | 実装言語（速度評価） | TypeScript据え置き（A）。体感速度はエッジ＋DB I/Oが支配的で言語非依存。移植性を壊さない最適化のみ標準採用 | CRUDはI/Oバウンド。言語変更の体感改善はほぼゼロ |

---

## 3. アーキテクチャ詳細

### 3.1. レイヤと責務

各ユニットは単一目的・独立テスト可能であること。

| レイヤ | 責務 | 依存 |
|---|---|---|
| **UI層**（Hono JSX） | HTML描画のみ。ドメイン層を呼ぶ。 | ドメイン層 |
| **API層**（Honoルート） | JSON入出力・Zod検証・HTTP関心事のみ。 | ドメイン層 |
| **ドメイン層** | テストケース/プロジェクト/履歴のビジネスロジック。HTTPもDBも知らない。 | Storageインターフェース |
| **Storageインターフェース** | `getTestCases()`, `createTestCase()` 等の抽象。CF固有APIをここで遮断。 | （実装に非依存） |
| **アダプタ実装** | D1／libSQL／better-sqlite3 ごとの具体実装。Drizzleで共通化。 | Drizzle + 各ドライバ |

### 3.2. ポータビリティ境界

アプリ本体（UI/API/ドメイン）は `Storage` インターフェースと `Auth` インターフェースしか参照しない。Cloudflare固有のバインディング（D1ハンドル、KV、Cache API、Smart Placement等）はアダプタ実装の内側に閉じ込める。

- **クラウド版エントリ:** Workers + D1アダプタ + （オプション）KV/Cacheアダプタ。
- **オンプレ版エントリ:** Node/Bun + libSQL or better-sqlite3アダプタ。
- 差分は「起動エントリ＋注入するアダプタ＋環境設定」のみ。ビジネスロジック・UI・APIは100%共通。

---

## 4. データモデル

### 4.1. エンティティ関係

```
Organization 1──N Project 1──N TestCase 1──N TestCaseObservation
                    │                  └────1──N TestCaseHistory
                    ├──N ApiToken (プロジェクト単位スコープ)
                    └──N SyncSession
```

MVPは Organization を単一固定（1行seed）で運用するが、テナント境界はデータアクセス層に最初から通す（Grill Q7）。

### 4.2. Organization（テナント境界・MVPは単一固定）

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK。MVPは固定の単一orgをseed。 |
| name | TEXT | 組織名 |
| created_at / updated_at | INTEGER (epoch ms) | タイムスタンプ |

### 4.3. Project

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| organization_id | TEXT (FK) | 所属org。**必須**。全クエリはorgで絞る（Grill Q7）。 |
| name | TEXT | プロジェクト名 |
| repo_url | TEXT? | 連携元リポジトリ（任意） |
| created_at / updated_at | INTEGER (epoch ms) | タイムスタンプ |

### 4.4. TestCase（★canonical＝人間の正・全衛星サービスの契約コア）

importはこのテーブルを物理的に触らない（観測は §4.5 TestCaseObservation へ。Grill Q3）。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK。安定ID。後段の `@TestCaseId` 紐付けに使用。 |
| project_id | TEXT (FK) | 所属プロジェクト（→org） |
| title | TEXT | テストケース名（人間可読） |
| target | TEXT? | 対象（例：`com.example.PaymentService#charge`） |
| category | TEXT enum | `normal` / `abnormal` / `boundary` / `error_handling` |
| given | TEXT | 事前条件（Given）。人間向けナレーション（散文はビュー扱い。Grill Q8） |
| when | TEXT | 操作（When） |
| then | TEXT | 期待結果（Then）。代表ケースの期待結果。 |
| parameters | JSON? | `@ParameterizedTest` 等データ駆動テスト用のデータセット配列 `[{name?, inputs, expected}, ...]`。Zodで型定義。（REV-02） |
| status | TEXT enum | `draft` / `approved` / `stale` / `archived`（※HITL承認ワークフローは未実装。値は手動変更可。`stale`はsync commitが自動付与） |
| **ownership** | TEXT enum | `machine` / `human`（Grill Q5）。人間の最初の編集 or 承認で `machine→human` に**不可逆**遷移。`machine`の間のみ観測をcanonicalにミラー。 |
| **drift** | INTEGER (bool) | `latest(observation)の指紋 ≠ canonicalの指紋`。**human-owned時のみ意味を持つ**（Grill Q1/Q8）。再承認・整合で解除。 |
| **fingerprint** | TEXT? | canonical確定時点のbehavioral-fingerprint（衛星供給・opaque。Grill Q8）。drift判定の基準値。 |
| **last_seen_sync_token** | TEXT? | 直近syncで出現確認に使ったトークン（Grill Q6）。stale判定を観測テーブル非走査で高速化。 |
| **last_seen_at** | INTEGER? | 直近にsyncで出現確認された時刻（Grill Q6） |
| version | INTEGER | 楽観的排他制御（OCC）用。更新ごとに +1。PATCHは現バージョン一致を要求し、不一致は 409。（REV-01） |
| confidence | REAL? | 抽出時の信頼度（衛星が付与、任意） |
| source_ref | JSON? | 出所参照（file/line/commit 等） |
| origin | TEXT enum | 作成元（`manual` / `discovery` / …）。トレーサビリティ用 |
| external_ref | TEXT? | 衛星側の参照ID（冪等取り込み用。opaque・安定性は衛星責任。Grill Q2） |
| metadata | JSON? | 柔軟メタデータ（タグ等）。SQLiteのJSON列。 |
| created_at / updated_at | INTEGER (epoch ms) | タイムスタンプ |

### 4.5. TestCaseObservation（衛星の観測時系列・変化点のみ記録）

importの書き込み先（Grill Q3）。**直前観測と指紋が異なる時だけ**行を作成（変化点のみ。Grill Q6）。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| test_case_id | TEXT (FK) | 対応するcanonical |
| project_id | TEXT (FK) | スコープ用（→org） |
| fingerprint | TEXT | この観測のbehavioral-fingerprint（衛星供給・opaque。Grill Q8） |
| observed | JSON | 観測スナップショット（given/when/then/parameters/source_ref 等） |
| sync_token | TEXT | この観測を記録したセッショントークン（Grill Q4/Q6） |
| origin | TEXT | 観測元の衛星 |
| created_at | INTEGER (epoch ms) | 観測時刻 |

保持ポリシー（変化点でも増えるため）はREV-05と同方針で適用。既定上限は実測後に決定（Grill Q6-C／MVPは上限なし）。

### 4.6. SyncSession（同期セッション・Grill Q4）

| 列 | 型 | 説明 |
|---|---|---|
| token | TEXT | PK。`start`で発行 |
| project_id | TEXT (FK) | 対象プロジェクト（→org） |
| origin | TEXT | 対象origin。**同一 `(project_id, origin)` の能動セッションは1つに限定**（重複`start`は409。Grill Q4-A） |
| status | TEXT enum | `active` / `committed` / `expired` |
| started_at / expires_at | INTEGER | 発行・失効時刻。失効セッションの観測はcanonicalに昇格させない |

### 4.7. ApiToken（衛星向け・プロジェクト単位スコープ・Grill Q7）

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| project_id | TEXT (FK) | スコープ対象プロジェクト（→org）。最小権限。 |
| token_hash | TEXT | トークンのハッシュ（平文は保存しない） |
| name | TEXT | 用途ラベル（どの衛星か） |
| created_at / revoked_at | INTEGER? | 発行・失効時刻 |

### 4.8. TestCaseHistory（人間の編集ログ・簡易変更履歴）

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT | PK |
| test_case_id | TEXT (FK) | 対象 |
| actor | TEXT | 実行者（ユーザ／衛星名） |
| action | TEXT enum | `created` / `updated` / `status_changed` / `imported` |
| delta | JSON | 変更フィールドのみの差分 `{field: {before, after}}`。フルスナップショットではなくデルタ保存で容量・I/Oを最適化。ネスト差分が必要ならRFC 6902(JSON Patch)形式も選択肢。（REV-05） |
| created_at | INTEGER (epoch ms) | 発生時刻 |

### 4.9. canonical 状態機械（Grill Q1/Q2/Q5）

`status`（draft/approved/stale/archived）と `ownership`（machine/human）の**二軸**で定義する。

```
[新規 import]
   └─▶ draft / machine-owned        … importで最新観測をcanonicalにミラー
         │  人間が編集 or 承認（最初の接触）
         ▼  ownership: machine ─不可逆─▶ human
   draft or approved / human-owned   … 以後 import は canonical を一切上書きしない
         │                               観測との指紋差は drift=true として記録のみ
         │  sync commit で当該originに未出現
         ▼
   stale（非破壊マーク）              … human-owned approved は stale 化しない（Q2-A 保護）
         │  後続 sync で external_ref 再出現
         ├─▶ stale 解除（直前 status へ復帰）
         │  人間が確認
         ▼
   archived（人間の明示操作・ソフトデリート）
```

- **ミラー境界（Q5）:** `machine`-owned の間のみ最新観測をcanonicalへミラー。人間の最初の接触で `human` 化し、ミラー停止＋drift記録へ切替。
- **drift（Q1/Q8）:** `human`-owned時のみ意味を持ち、`latest(observation).fingerprint != canonical.fingerprint` で true。再承認・整合で false。
- **stale（Q2/Q5）:** sync commit時、当該originで `last_seen_sync_token != 今回token` のcanonicalを `stale` 化。**approvedは保護**。machine-owned draftの未出現も例外なく `stale` 経由（状態機械を一本化）。

### 4.10. 設計上のポイント

- **Given/When/Then は人間向けナレーション（ビュー）**。同一性・drift判定は散文ではなく **behavioral-fingerprint**（衛星供給・opaque。Grill Q8）で行う。Gherkin/自然言語ビューはこの3列＋`parameters`から派生描画。
- **同一性は衛星責任・TMSは契約**：`external_ref`（同一ケース判定）も `fingerprint`（挙動変化判定）も、TMSはopaqueに扱い、安定性の責任は衛星に課す（Grill Q2/Q8で一貫）。
- **import経路の分離（Q3）**：importは `TestCaseObservation`（＋canonicalの `last_seen_*` 軽量update）にのみ書き、canonical本体は触らない。machine-owned時のみcanonicalへミラー昇格。
- **テナント境界（Q7）**：`Storage` インターフェースの全メソッドが orgScope を要求するシグネチャ。全クエリをorgで絞り、越境をコンパイル時に防止。APIトークンは project スコープ、`:pid` のorg不一致は403。
- **Zodスキーマを単一の真実の源**とし、API入力検証・DBモデル・型を一元化（Drizzleと連携）。
- SQLite方言に閉じることで、D1⇔libSQL⇔better-sqlite3 でスキーマ・SQLを共通化。
- インデックス: `(project_id, status)`, `(project_id, category)`, `(project_id, external_ref)`, `(project_id, origin, last_seen_sync_token)`（stale判定用）, Observation側 `(test_case_id, created_at)`, `(project_id, sync_token)`。
- **楽観的排他制御（OCC, REV-01）:** human操作の並行更新を防ぐ。PATCHは `version` 一致を要求し、不一致時は 409。
- **パラメータ化テスト（REV-02）:** `given/when/then` は代表シナリオ、入力値・期待値のバリエーションは `parameters` 配列に構造化保持。
- **履歴のデルタ保存＋保持ポリシー（REV-05）:** 変更フィールドのみ記録。保持期間／件数上限でコンパクション（既定値は実装計画で決定）。

---

## 5. API設計

すべてZodで検証。UIもこのドメイン層を共有（API/UIで二重実装しない）。レスポンスは一貫したエラー形（Zod検証失敗→422、詳細メッセージ）。

### 5.1. 参照・操作系（UIと共有）

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/projects` | プロジェクト一覧 |
| POST | `/api/projects` | プロジェクト作成 |
| GET | `/api/projects/:pid/testcases` | テストケース一覧（`status`/`category`フィルタ、ページング） |
| POST | `/api/projects/:pid/testcases` | テストケース作成（手動） |
| GET | `/api/testcases/:id` | 単体取得 |
| PATCH | `/api/testcases/:id` | 編集（status変更含む） |
| DELETE | `/api/testcases/:id` | 削除（実体はarchive推奨） |
| GET | `/api/testcases/:id/history` | 変更履歴 |
| GET | `/api/testcases/:id?format=gherkin` | Gherkin/自然言語ビューを派生生成 |

### 5.2. 衛星サービス向け取り込みAPI（★ハブの肝・同期セッション方式）

単発Upsertではソース側で削除されたテストケースがTMSに残り続ける（オーファン化）。これを防ぐため、取り込みを**「同期セッション」**として設計する（REV-03）。

| メソッド | パス | 用途 |
|---|---|---|
| POST | `/api/projects/:pid/sync/start` | 同期セッション発行。`origin` を指定し `sync_token` を返す。**同一 `(project_id, origin)` に能動セッションがあれば 409**（Grill Q4-A）。 |
| POST | `/api/projects/:pid/sync/:token/chunk` | 観測群を投入。各ケースを `external_ref` で同定し、(1) `TestCaseObservation` を**指紋が変化した時のみ**作成（変化点。Q6）、(2) canonicalの `last_seen_sync_token`/`last_seen_at` を軽量update、(3) 対応canonicalが無ければ新規 `draft/machine-owned` 作成、(4) `machine`-owned canonical は最新観測をミラー、`human`-owned は触れず指紋差を `drift` 記録（Q1/Q3/Q5/Q8）。canonical本体の上書きはしない。 |
| POST | `/api/projects/:pid/sync/:token/commit` | セッション確定（1リクエスト内のD1トランザクションでアトミック）。当該originで `last_seen_sync_token != 今回token` のcanonicalを `stale` 化（**approved/human-owned approvedは保護**。Q2/Q5）。セッションを `committed` に。 |

- 小規模セットでは start→1回 chunk→commit で完結。チャンク分割は大規模時のための任意分割。
- stale判定は canonical の `(project_id, origin, last_seen_sync_token)` インデックスで効率化（観測テーブルを走査しない。Q6）。
- セッションは `expires_at` で失効。失効・未commitセッションの観測は **canonicalに昇格させない**（ミラー・stale化を保留）。
- **chunk再送の冪等性：** 変化点記録（同一指紋なら観測行を作らない）＋ `external_ref` 同定 ＋ `last_seen` の冪等update により、同一chunkの再送は自然に冪等（Grill Q6/Q8の副産物）。

### 5.3. 認証・テナント境界・流量制御

- **APIトークン**（衛星サービス用）と**セッション**（UI用）を分離。取り込み／同期APIはトークン認証必須。トークンはハッシュ保存。
- **テナント境界の強制（Grill Q7）:** トークンは **project スコープ**（→org）。ミドルウェアで「トークンのproject == `:pid`、かつ同一org」を検証し、不一致は **403**。`Storage` の全メソッドは orgScope を必須引数とし、越境クエリを構造的に不可能にする。
- **レートリミット（REV-06）:** トークン別のレート制限を Hono ミドルウェア層に実装し、ハルシネーション／ループバグによる暴走リクエスト（実質DDoS）からハブを保護。
- **サーキットブレーカー（REV-06, 将来）:** 異常な失敗率・流量を検知したトークンを一時遮断する機構を将来追加（MVPはレート制限のみ）。

---

## 6. UI（素朴・最小JS）

Hono JSXのSSR＋HTMXで部分更新。画面は3つ：

1. **プロジェクト一覧/作成** — 一覧＋新規フォーム。
2. **テストケース一覧**（プロジェクト配下） — テーブル表示。`category`/`status`フィルタ、検索。各行クリックで詳細。HTMXでフィルタ部分更新。
3. **テストケース詳細/編集** — Given/When/Thenの構造化フォーム＋`status`変更＋`origin`/`source_ref`表示＋「Gherkinビュー」タブ＋変更履歴。**`drift` バッジ**（human-ownedで観測と乖離）と **`stale` バッジ**（コード側で消えた候補）を表示し、人間が確認・整合できる導線を置く（Grill Q1/Q2）。最新観測（`TestCaseObservation`）との簡易対比も表示。

差分比較ビューやリッチな承認UI（drift解消・stale/draftのマージ）は後続（HITL実装時）。MVPは「drift/staleの可視化」までで、整合操作は手動status変更で代替。

**制約：リアルタイム同期（REV-07）。** バックグラウンドでサテライトがステータス等を変更しても、HTMXの部分更新はユーザがアクションするまで最新化されない。MVPではこれを許容し、一覧画面に手動リフレッシュ、必要なら HTMX のポーリング（`hx-trigger="every Ns"`）を任意で用意する。将来的に SSE（Server-Sent Events）による状態のリアルタイム同期を導入する余地を残す。

---

## 7. 認証（最小）

- **UI:** 簡易セッション（単一組織・少人数想定の最小ログイン）。Cloudflare Accessは「使うなら前段の任意オプション」で、本体は依存しない（＝オンプレ移植性を維持）。
- **API（衛星）:** プロジェクト単位のAPIトークン（ヘッダ `Authorization: Bearer ...`）。トークンはハッシュ保存。
- 認証ロジックも `Auth` インターフェースとして抽象化し、オンプレでは別IdP差し替え可能に。
- **テナント境界は論理的に最初から全データアクセスへ通す（Grill Q7）。** `Organization` を第一級・`Project.organization_id` 必須FK、`Storage` 全メソッドが orgScope を要求、トークンは project スコープで越境403。MVPは単一orgをseedして運用するが、コードパスは常にorgを通す。**物理的なテナント分離（テナント別D1等）は将来の最適化**でアダプタ裏に隠す。

---

## 8. テスト方針・パフォーマンス最適化

### 8.1. テスト方針

- **TDD前提**。ドメイン層は純粋関数中心で、Storageをモックして単体テスト。
- **テストランナー:** Vitest（Workers環境は `@cloudflare/vitest-pool-workers` でD1含め統合テスト）。
- **Storageアダプタは契約テスト**（同一テストスイートをD1/libSQL両実装に通し、移植性を機械的に保証）。

### 8.2. パフォーマンス評価の結論

CRUDワークロードはI/Oバウンドであり、体感レスポンスはコールドスタート・エッジ配置・DB I/Oが支配的。アプリのCPU処理は全体の数%以下のため、実装言語の変更による体感改善はほぼゼロ。Cloudflare Workers + TypeScript + Hono は既に体感速度の最適解であり、かつオンプレ移植性も両立する。

### 8.3. 標準採用の最適化（移植性非破壊）

- D1インデックス設計（`project_id`, `status`, `category`, `external_ref`）。
- SSR＋HTMXで最小ペイロード。
- エッジ配置（Workers既定）。

### 8.4. オプション最適化（アダプタ裏に隔離、CF固有）

- Cache API / KV による読みキャッシュ。
- Smart Placement（WorkerをD1の近くに自動配置）。
- **書き込み直列化キュー（REV-04, 将来フック）:** D1(SQLite)は単一ライタのため、サテライトからの超高頻度バッチWriteは書込競合（BusyTimeout）を招き得る。将来、サテライトとD1の間に **Cloudflare Queues** を挟み、Writeをバッチ・直列化するアーキテクチャを採れるよう、取り込み経路を**Storage/Ingestインターフェースの裏**に閉じておく。Queuesは**CF固有**のため、オンプレでは別キュー（or 直接Write）に差し替え可能とし、ポータビリティ境界を越えさせない。MVPでは実装せず、設計記載のみ。

---

## 9. 今回のスコープ外（後続サブプロジェクト）

- HITL承認ワークフロー＋差分比較UI（③）。
- Discovery衛星サービス（純LLM方式 → 静的解析グラウンディング）。
- Agentic Test Generation 衛星サービス（JUnitコード生成＋`@TestCaseId`付与）。
- Self-Healing 衛星サービス（CI連携・自動修復PR）。
- 本格的なマルチテナント分離。

---

## 10. レビュー反映（2026-06-26）

設計レビュー指摘 REV-01〜07 への対応。

| ID | 優先度 | 指摘 | 判定 | 反映先 |
|---|---|---|---|---|
| REV-01 | 高 | 並行更新によるロストアップデート | 採用（MVP） | §4.3 `version`列、§4.5 OCC、§5.2 PATCH=409 |
| REV-02 | 高 | パラメータ化テストの構造化欠如 | 採用（MVP） | §4.3 `parameters`列、§4.5 |
| REV-03 | 高 | 削除済テストのオーファン化 | 採用（MVP） | §5.2 同期セッション（start/chunk/commit） |
| REV-04 | 中 | D1 Write競合（BusyTimeout） | 採用（将来フック・設計記載のみ） | §8.4 Cloudflare Queues、ポータビリティ境界の裏 |
| REV-05 | 中 | 履歴テーブルの肥大化 | 修正採用 | §4.4 デルタ保存（フルJSON→変更フィールド差分）、§4.5 保持ポリシー。RFC6902は選択肢 |
| REV-06 | 中 | サテライト暴走時の防御欠如 | 採用（レート制限MVP／CB将来） | §5.3 レートリミット、サーキットブレーカー |
| REV-07 | 低 | HTMXと非同期更新の不整合 | 採用（制約記載） | §6 リアルタイム同期の制約・将来SSE |

**REV-05の技術的調整:** `TestCase` はフラットなレコードのため、RFC 6902(JSON Patch) の完全採用ではなく「変更フィールドのみの差分 `{field:{before,after}}`」を既定とした。容量・I/O削減効果を得つつ履歴の可読性・復元容易性を維持する。ネスト構造の差分が必要な箇所が出た場合に RFC 6902 を選択肢として用いる。

---

## 11. Grilling反映（2026-06-26・シニアアーキテクトレビュー）

設計ツリーの深い枝を1問ずつ降り、根幹に関わる8点を確定した。これらは§3〜§7に反映済み。

| Q | 確定事項 | 解いた問題 | 主な反映先 |
|---|---|---|---|
| Q1 | approved保護＋drift検知をMVPに | 人間 vs 衛星の競合で承認内容が機械的に消失する事故 | §4.4 `drift`、§4.9 状態機械、§6 driftバッジ |
| Q2 | オーファンは即archiveせず`stale`非破壊。approvedは絶対stale化しない | リネーム等で承認資産が分断・消失する | §4.4 `status=stale`、§4.9、§5.2 commit |
| Q3 | 観測を `TestCaseObservation` に分離し、importはcanonicalを物理的に触らない | canonical（人間の正）の不可侵を保証 | §4.5 観測テーブル、§4.10、§5.2 chunk |
| Q4 | `sync_token`タグ＋同一origin単一能動セッション（重複`start`は409） | セッションまたがり・同時実行でのstale誤爆 | §4.6 SyncSession、§5.2 |
| Q5 | ownership二軸（machine/human）。人間の最初の接触で不可逆にhuman化 | ミラー停止境界の曖昧さ／編集途中の消失 | §4.4 `ownership`、§4.9 状態機械 |
| Q6 | 変化点のみ観測記録＋canonicalに軽量`last_seen`。保持は実測後 | 観測時系列の爆発とD1物理上限 | §4.4 `last_seen_*`、§4.5、§5.2 |
| Q7 | テナント境界を今通す（org必須FK＋Storage orgScope）。トークンはproject単位 | SaaS化時のretrofit地獄、越境アクセス | §4.2/4.3 org、§5.3、§7 |
| Q8 | behavioral-fingerprintで比較（衛星供給・opaque）。散文はビュー | LLMの言い回し揺れがdrift/変化点をノイズ化 | §4.4 `fingerprint`、§4.10、§5.2 |

**一貫する設計原則（Grillで明確化）:** 「同一性・挙動変化の判定（`external_ref` / `fingerprint`）は衛星の責任、TMSはopaqueに扱い安定キーの契約だけ定義する」。これにより、TMSは普通のCRUD＋境界制御に徹し、AI由来の不確実性をハブから締め出す。

**注:** §10の節番号参照は反映当時のもので、本Grilling反映により一部節番号が繰り下がっている（データモデルは §4.2〜§4.10）。
