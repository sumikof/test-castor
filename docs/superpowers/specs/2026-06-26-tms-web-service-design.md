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
Organization (将来のマルチテナント用、初版は単一固定)
   └─ Project 1──N TestCase 1──N TestCaseHistory
```

### 4.2. Project

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| name | TEXT | プロジェクト名 |
| repo_url | TEXT? | 連携元リポジトリ（任意） |
| created_at / updated_at | INTEGER (epoch ms) | タイムスタンプ |

### 4.3. TestCase（★全衛星サービスの契約となるコア）

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK。安定ID。後段の `@TestCaseId` 紐付けに使用。 |
| project_id | TEXT (FK) | 所属プロジェクト |
| title | TEXT | テストケース名（人間可読） |
| target | TEXT? | 対象（例：`com.example.PaymentService#charge`） |
| category | TEXT enum | `normal` / `abnormal` / `boundary` / `error_handling` |
| given | TEXT | 事前条件（Given） |
| when | TEXT | 操作（When） |
| then | TEXT | 期待結果（Then） |
| status | TEXT enum | `draft` / `approved` / `archived`（※HITLワークフローは未実装。値は手動変更可） |
| confidence | REAL? | 抽出時の信頼度（衛星が付与、任意） |
| source_ref | JSON? | 出所参照（file/line/commit 等） |
| origin | TEXT enum | 作成元（`manual` / `discovery` / …）。トレーサビリティ用 |
| external_ref | TEXT? | 衛星側の参照ID（冪等取り込み用） |
| metadata | JSON? | 柔軟メタデータ（タグ等）。SQLiteのJSON列。 |
| created_at / updated_at | INTEGER (epoch ms) | タイムスタンプ |

### 4.4. TestCaseHistory（簡易変更履歴）

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT | PK |
| test_case_id | TEXT (FK) | 対象 |
| actor | TEXT | 実行者（ユーザ／衛星名） |
| action | TEXT enum | `created` / `updated` / `status_changed` / `imported` |
| snapshot | JSON | 変更後の全体スナップショット（簡易差分の元データ） |
| created_at | INTEGER (epoch ms) | 発生時刻 |

### 4.5. 設計上のポイント

- **Given/When/Then を構造化列で保持** → Gherkinテキストはこの3列から組み立てて表示。自然言語ビューも同様に派生。
- **`origin` / `external_ref`** で「どの衛星がいつ入れたか」を追跡し、再取り込み時の冪等性（同一 `external_ref` は update）を担保。
- **Zodスキーマを単一の真実の源**とし、API入力検証・DBモデル・型を一元化（Drizzleと連携）。
- SQLite方言に閉じることで、D1⇔libSQL⇔better-sqlite3 でスキーマ・SQLを共通化。
- インデックス: `project_id`, `status`, `category`, `external_ref`。

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

### 5.2. 衛星サービス向け取り込みAPI（★ハブの肝）

| メソッド | パス | 用途 |
|---|---|---|
| POST | `/api/projects/:pid/import` | ドラフトの一括取り込み。`origin`＋`external_ref` で冪等（同一refはupsert）。`status=draft` で投入。 |

### 5.3. 認証の分離

- **APIトークン**（衛星サービス用）と**セッション**（UI用）を分離。
- 取り込みAPIはトークン認証必須。

---

## 6. UI（素朴・最小JS）

Hono JSXのSSR＋HTMXで部分更新。画面は3つ：

1. **プロジェクト一覧/作成** — 一覧＋新規フォーム。
2. **テストケース一覧**（プロジェクト配下） — テーブル表示。`category`/`status`フィルタ、検索。各行クリックで詳細。HTMXでフィルタ部分更新。
3. **テストケース詳細/編集** — Given/When/Thenの構造化フォーム＋`status`変更＋`origin`/`source_ref`表示＋「Gherkinビュー」タブ＋変更履歴。

差分比較ビューやリッチな承認UIは後続（HITL実装時）。

---

## 7. 認証（最小）

- **UI:** 簡易セッション（単一組織・少人数想定の最小ログイン）。Cloudflare Accessは「使うなら前段の任意オプション」で、本体は依存しない（＝オンプレ移植性を維持）。
- **API（衛星）:** プロジェクト単位のAPIトークン（ヘッダ `Authorization: Bearer ...`）。トークンはハッシュ保存。
- 認証ロジックも `Auth` インターフェースとして抽象化し、オンプレでは別IdP差し替え可能に。
- マルチテナントの本格分離は後続（スキーマに `organization` の種だけ残す）。

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

---

## 9. 今回のスコープ外（後続サブプロジェクト）

- HITL承認ワークフロー＋差分比較UI（③）。
- Discovery衛星サービス（純LLM方式 → 静的解析グラウンディング）。
- Agentic Test Generation 衛星サービス（JUnitコード生成＋`@TestCaseId`付与）。
- Self-Healing 衛星サービス（CI連携・自動修復PR）。
- 本格的なマルチテナント分離。
