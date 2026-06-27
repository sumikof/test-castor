# TMS Web Service 設計書

- **作成日:** 2026-06-26
- **対象:** Agentic QA TMS プラットフォームの第1サブプロジェクト「TMS Web Service（ハブ）」
- **ステータス:** 第3次Grilling反映済み（独立5観点レビュー → RC-1〜RC-3＋Critical/High を G12〜G18 で解決。残るMedium/Lowは個別反映。レビュー報告書は `2026-06-26-tms-web-service-design-review.md`）

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

アプリ本体（UI/API/ドメイン）は `Storage` / `Auth` / `RateLimiter` インターフェースしか参照しない（**RateLimiterは第4のポータビリティ境界**。G8）。Cloudflare固有のバインディング（D1ハンドル、KV、Cache API、Durable Objects、CF Rate Limiting binding 等）はアダプタ実装の内側に閉じ込める。

**注（D1-8）:** Smart Placement は**バインディングでもコードでもなく Worker のランタイム設定**（`placement = { mode = "smart" }`）であり、隠蔽すべきAPI表面を持たない。ポータビリティ境界の議論からは外し、「クラウド固有のランタイム設定（オンプレでは設定不在になるだけ）」として §8.4 に分類する。Cache API/KV をアダプタ裏に置く構想は妥当。

- **クラウド版エントリ:** Workers + D1アダプタ + （オプション）KV/Cacheアダプタ。
- **オンプレ版エントリ:** Node/Bun + libSQL or better-sqlite3アダプタ。
- 差分は「起動エントリ＋注入するアダプタ＋環境設定」のみ。ビジネスロジック・UI・APIは100%共通。

---

## 4. データモデル

### 4.1. エンティティ関係

```
Organization 1──N Project 1──N TestCase 1──N TestCaseObservation
        │           │                  ├────1──N TestCaseIdentity (origin別・マルチホーミング)
        │           │                  └────1──N TestCaseHistory
        │           ├──N ApiToken (プロジェクト単位スコープ)
        │           └──N SyncSession 1──N SyncStaging (commit作業領域・G14)
        └──N User 1──N Session (UIログイン・G5)
```

MVPは Organization を単一固定（1行seed）で運用するが、テナント境界はデータアクセス層に最初から通す（Grill Q7）。

### 4.2. Organization（テナント境界・MVPは単一固定）

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK。MVPは固定の単一orgをseed。 |
| name | TEXT | 組織名 |
| created_at / updated_at | INTEGER (epoch ms) | タイムスタンプ |

### 4.2a. User（UIユーザ・第一級・G5）

MVPでもユーザ実体を第一級で持つ（テナント境界Q7と同じ「retrofit地獄回避」の論法）。承認・編集の権威を「誰か」に帰属させ、監査を成立させる。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| organization_id | TEXT (FK) | orgスコープ（Q7と一貫） |
| email | TEXT | ログインID（org内一意） |
| password_hash | TEXT? | **PHC string形式**（G17）。アルゴリズム識別子＋パラメータ＋per-userソルト＋ハッシュを内包（例 `$pbkdf2-sha256$i=600000$<salt>$<hash>`）。MVP既定＝**WebCrypto PBKDF2-SHA256・イテレーション600,000（OWASP 2023基準）・16バイトCSPRNGソルト**。検証はプレフィックスでアルゴリズムdispatch、ログイン成功時に旧→新形式へ**透過再ハッシュ**しオンプレargon2へ無停止移行可。`Auth` 裏に隔離（G5/G17）。外部IdP時はnull可。 |
| display_name | TEXT | 表示名 |
| role | TEXT enum | `admin` / `editor` / `viewer`。トークン発行/失効等の管理操作は `admin` 限定（G6）。CHECK制約。 |
| created_at / updated_at | INTEGER (epoch ms) | タイムスタンプ |

### 4.2b. Session（UIセッションストア・G5/G17）

KV依存を避け**D1/SQLite上で共通管理**（ポータビリティ維持）。Cookieには署名付きセッションIDのみ。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT | PK。Cookieに載る署名付きセッションID。**ログイン成功時に必ず再発行**（セッション固定攻撃対策。G17） |
| user_id | TEXT (FK) | ログインユーザ |
| expires_at | INTEGER | 失効時刻。認証ミドルウェアが毎リクエスト `expires_at > now` を述語検証（超過は401＋行掃除。G16決定3/G17） |
| created_at | INTEGER (epoch ms) | 発行時刻 |

**Cookie属性（必須・G17）:** `HttpOnly; Secure; SameSite=Lax; Path=/`。
**署名鍵（G17）:** 署名鍵はSecret管理（CF Secret／オンプレはsecret manager）。**鍵IDをプレフィックスで埋め**、新鍵発行・旧鍵検証の猶予期間を保って**無停止ローテーション**。検証は「**署名検証 → DB存在 → 未失効**」の三段AND（G16決定3）。
**ライフサイクル（G17）:** ログアウトAPIでSession行削除。**パスワード変更／role変更時は当該userの全セッションを無効化**（`DELETE FROM Session WHERE user_id=?`＝インシデント時の緊急遮断）。
**CSRF（G17）:** SameSite=Lax を一次防御に、状態変更メソッド（POST/PATCH/DELETE）に **double-submit CSRFトークン**（または `Origin`/`Referer` 検証）を必須。HTMXは `hx-headers` でCSRFトークンを全変更リクエストに自動付与。GETは副作用なし（CSRF不要）を不変条件とする。
**読みスケール（D1-6）:** セッション検証は read-heavy のため、クラウドは **D1 read replication（Sessions API）** の採用を運用要件とする。

### 4.3. Project

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| organization_id | TEXT (FK) | 所属org。**必須**。全クエリはorgで絞る（Grill Q7）。 |
| name | TEXT | プロジェクト名 |
| repo_url | TEXT? | 連携元リポジトリ（任意） |
| created_at / updated_at | INTEGER (epoch ms) | タイムスタンプ |

### 4.4. TestCase（★canonical＝人間の正・全衛星サービスの契約コア）

canonical変異の**書き込みは commit 時のみ**（G12：chunkは §4.6 TestCaseObservation への追記専用。canonical/identity/ミラー/staleには触れない）。commit の述語駆動集合文（§5.2）が、以下に二分した列を書く（G2）：

- **人間所有列**（commit由来の書き込み不可侵・OCC `version` 管理対象）：`title` / `target` / `category` / `given` / `when` / `then` / `parameters` / `status` / `confidence` / `metadata`。**`status` は完全に人間所有**（G3でstaleness分離後、システムがstatusを書く正当パスは存在しない＝旧「システム由来status遷移」記述は撤回。DM-M3）。
- **システム可変列**（commitの集合文が書く・`version` をbumpしない）：`is_stale`（**派生キャッシュ**。真実の源は §4.5 identity。G13）/ `drift` / `fingerprint` / `mirror_origin` / `system_updated_at`。
- **`ownership`（DM-M2）:** 人間所有でもシステム可変でもない**遷移専用列**。`machine→human` は人間の初編集PATCHと**同一文・同一トランザクションで `version` を+1**して遷移（誤操作救済は §4.10 の re-adopt 参照）。

ミラー昇格（machine-owned期間中に人間所有列名へ観測を書く）は **`WHERE ownership='machine' AND status NOT IN ('archived') AND mirror_origin=:O` のガード付き相関UPDATE単一文**に畳み込む（CC-A1：人間の初編集との競合をD1単一ライタが原子的に相互排他＝OCC圏外のimport↔人間ロストアップデートを構造排除。G14）。

**`updated_at` の分離（CC-A3）:** 人間編集時刻 `human_updated_at` とシステム書き込み時刻 `system_updated_at` を分離（共有列の後勝ちによる監査・キャッシュ無効化・整列の汚染を防止）。

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
| status | TEXT enum | `draft` / `approved` / `archived`（**3値に純化**。`stale`はenumから外し直交フラグ `is_stale` へ移した。G3）。※HITL承認ワークフローは未実装。値は手動変更可。CHECK制約＋Zodで二重防御（G10）。 |
| **is_stale** | INTEGER (bool) | **canonical集約の派生キャッシュ**（真実の源は §4.5 `TestCaseIdentity.is_stale`。G13）。commitのrollupで「**TTL以内の live identity がすべて stale**」のとき true（凍結originは集約から除外）。UIバッジ・`(project_id,is_stale)` 索引の高速フィルタ用。`status NOT IN ('approved','archived')` を rollup で保護。システム可変列。 |
| **ownership** | TEXT enum | `machine` / `human`（Grill Q5）。人間の最初の編集 or 承認で `machine→human` に**不可逆**遷移。`machine`かつ**非archived**の間のみ観測をcanonicalにミラー（G7）。CHECK制約。 |
| **mirror_origin** | TEXT? | **ミラー権威オリジン**（G1・マルチホーミング）。machine-owned canonicalへ内容ミラー／`fingerprint`更新できるのは**このオリジンの観測のみ**。既定はcanonical作成オリジン。他オリジンの観測は台帳（identity.last_seen）記録のみで内容ミラーしない＝複数machineオリジン多重同定時の内容フラップ（last-writer-wins非決定性）を排除。 |
| **drift** | INTEGER (bool) | `latest(committed観測).指紋 ≠ canonical.指紋`。**ownership=human かつ 非archived時のみ立てる**（DM-H5：machine/archivedには記録しない）。基準は `mirror_origin` の最新committed観測指紋。再承認・整合（後述 accept-fingerprint）で解除。`latest` は**committedセッション由来の観測のみ**対象（G4）。**`fingerprint` が null（手動作成）のケースは drift 未評価＝false**（DM-L1）。システム可変列。 |
| **fingerprint** | TEXT? | canonical確定時点のbehavioral-fingerprint（衛星供給・opaque。Grill Q8）。drift判定の基準値。machine-owned期間は `mirror_origin` の観測で更新。**human-owned後は凍結**するが、人間の **accept-fingerprint 操作**（最新committed観測の指紋を採用＝`UPDATE SET fingerprint=?, version=version+1 WHERE version=?`）でdriftを解消可能（DM-H3/CC-A4：OCC保護下）。システム可変列（accept-fingerprintのみ人間がOCC下で書く例外）。 |
| version | INTEGER | 楽観的排他制御（OCC）用。**人間所有列の更新時のみ +1**（G2）。PATCHは現バージョン一致を要求し、不一致は 409。importによるシステム可変列の更新は **versionをbumpしない**（人間の編集中の衛星syncで理不尽な409を起こさない）。（REV-01/G2） |
| confidence | REAL? | 抽出時の信頼度（衛星が付与、任意） |
| source_ref | JSON? | 出所参照（file/line/commit 等） |
| created_origin | TEXT enum | 作成元の記録（`manual` / `discovery` / …）。provenance表示用。**同定の権威は §4.5 TestCaseIdentity が持つ**（REV-08） |
| metadata | JSON? | 柔軟メタデータ（タグ等）。SQLiteのJSON列。ホットなフィルタ条件は生成列＋索引へ昇格（REV-11、§4.11） |
| created_at / updated_at | INTEGER (epoch ms) | タイムスタンプ |

注：`origin` / `external_ref` / `last_seen_*` は **canonicalから外し**、複数プロデューサが同一ケースを独立同定できるよう §4.5 TestCaseIdentity（マルチホーミング）へ移した（REV-08）。`created_origin` は provenance表示のための作成元記録にとどまり、ミラー権威は `mirror_origin`（G1）が、同定の権威は §4.5 が持つ。

### 4.5. TestCaseIdentity（衛星ごとの同定・マルチホーミング・REV-08）

1つのcanonicalに対し、**複数のオリジンがそれぞれの `external_ref` で同時に紐づける**。per-origin の同期台帳もここに置くことで、マルチオリジン時のstale判定を正しくする（オリジンXが未観測でもYが観測中なら stale 化しない）。**staleness の真実の源はここ**（`(test_case_id, origin)` 粒度。canonical.is_stale はこの集約の派生キャッシュ。G13）。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| test_case_id | TEXT (FK) | 紐づくcanonical |
| project_id | TEXT (FK) | スコープ用（→org） |
| origin | TEXT | このidentityのオリジン（衛星） |
| external_ref | TEXT | 当該オリジンの参照ID（opaque・安定性は衛星責任。Grill Q2／長さ≤512・printable ASCII の契約は §5.5。API-7）。`(project_id, origin, external_ref)` で一意・冪等同定 |
| **is_stale** | INTEGER (bool) | **per-origin staleness の真実の源**（G13）。commit時、当該originの今回sessionで未出現（`last_seen_sync_token != :T`）なら true、再出現で false。各originのcommitは**自分のidentity行のみ**を触る＝origin間で完全独立・無競合（CC-C1解消）。canonical.is_stale はこの集約（TTL内liveが全stale）から導出。 |
| last_seen_sync_token | TEXT? | このオリジンの直近**committed** syncでの出現トークン（Grill Q6／G15：判定は `SyncSession.status='committed' OR token=:T` でフェンス）。stale判定を観測テーブル非走査で高速化 |
| last_seen_at | INTEGER? | このオリジンが直近に出現確認した時刻。**集約rollupの live 判定（TTL=90日既定）に使用**＝凍結origin（decommission）を集約から除外し永久取りこぼしを防ぐ（DM-C2/G13） |
| created_at | INTEGER (epoch ms) | 紐付け時刻 |

> **凍結origin問題の解（G13）:** 「全オリジンがstaleなら canonical stale」を単純な論理積で取ると、二度とsyncしてこない引退オリジンの古い `is_stale=false` が永久ブロッカーになる。rollup は `last_seen_at > now - TTL` の **live identity のみ**を対象とし、TTL超の凍結identityは集約から除外する（自律回復）。

> 補足（REV-08の根拠整理）：Test Generation衛星が「生成コード・カバレッジ」を結びつけるのは*同定*ではなく canonical.id への*逆参照*であり、将来の別テーブル `GeneratedArtifact(test_case_id, …)` でモデル化する（identityはDiscoveryのようなプロデューサがケースをUpsertするためのもの）。

### 4.6. TestCaseObservation（衛星の観測時系列・変化点のみ記録）

**chunk の唯一の書き込み先**（G12：chunkはここへ append 専用。canonical/identity/ミラー/staleには触れない）。**直前観測と指紋が異なる時だけ**行を作成（変化点のみ。Grill Q6）。**変化点の比較基準は `(test_case_id 暫定はexternal_ref, origin)` 単位**（DM-H6：per-canonical比較だとマルチホーミングでorigin間が交互に変化点判定され観測爆発するため、必ずorigin単位で比較）。

新規ケースは chunk 時点で canonical.id 未確定のため、observation は **`external_ref` で記録**し、commit のステージング処理（§5.2）で `test_case_id` を確定・backfillする。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| test_case_id | TEXT (FK?) | 対応するcanonical（新規ケースはcommitのステージングで確定・backfill） |
| external_ref | TEXT | 観測元の参照ID（commit前の同定キー） |
| project_id | TEXT (FK) | スコープ用（→org） |
| fingerprint | TEXT | この観測のbehavioral-fingerprint（衛星供給・opaque。Grill Q8／長さ≤512契約は §5.5） |
| observed | JSON | 観測スナップショット。**固定キーセット `{given, when, then, parameters, source_ref, schema_version}`**（§5.5・API-6：`schema_version` で構造化Diffのバージョン跨ぎを区別）。**バイトサイズはZodで上限検証**（D1の行2MB上限 D1-7 を割らない） |
| sync_token | TEXT | この観測を記録したセッショントークン（Grill Q4/Q6） |
| origin | TEXT | 観測元の衛星 |
| created_at | INTEGER (epoch ms) | 観測時刻 |

**冪等性の一意制約（CC-D1/G14）:** `(external_ref, origin, sync_token, fingerprint)` に一意制約を張り、chunkは `INSERT … ON CONFLICT DO NOTHING`。同一chunkのネットワーク再送・並行二重処理が**観測を二重INSERTしない**ことをDBが保証（変化点のみ契約と容量を守る）。

保持ポリシー（変化点でも増えるため）はREV-05と同方針で適用。**「MVPは上限なし」は撤回（G11）**：件数基準（直近N変化点）は実測後に決めるが、**時間基準の既定値をMVPから設定**（例：committed観測は90日保持、それより古いものはパージ）。パージ機構に必ず仕事を与え、無制限増加を原理的に止める。

**パージの不変条件（G11/DM-M4）：** drift/構造化Diffの足場を壊さないため、**各 `(test_case_id, origin)` につき直近の committed 観測を最低1件は期間に関わらず必ず残す**（per-origin強化：マルチホーミング時に片origin観測が全消去されると、そのoriginビューの構造化Diff〔§6 REV-09〕が基準を失うため）。パージの削除・残置の両述語に **`status='committed'` フィルタ**（observation→SyncSession join）を強制し、未確定観測を survivor に誤認しない（CC-E1）。削除は単一の相関サブクエリ付き集合DELETEで原子化し、`DELETE … LIMIT` の小バッチ反復で30秒/行数上限を回避（D1-3）。

**意味論的隔離（G4）：** drift/stale判定・構造化Diffが参照する `latest(observation)` は **`SyncSession.status='committed' OR token=:T` 由来の観測のみ**を対象とし（G15フェンス）、active/expiredセッション由来の観測は物理的に残っても意味論的に無視する。パージは未確定観測を優先回収。

### 4.7. SyncSession（同期セッション・Grill Q4）

| 列 | 型 | 説明 |
|---|---|---|
| token | TEXT | PK。`start`で発行 |
| project_id | TEXT (FK) | 対象プロジェクト（→org） |
| origin | TEXT | 対象origin。**同一 `(project_id, origin)` の能動セッションは1つに限定**（重複`start`は409。Grill Q4-A） |
| status | TEXT enum | `active` / `committed` / `expired`。CHECK制約。 |
| started_at / expires_at | INTEGER | 発行・失効時刻。失効セッションの観測はcanonicalに昇格させない |

**一意性のDB委譲（CC-B1/G15）:** 「未失効activeがあれば409」のアプリ層 check-then-act は D1 のインタラクティブTX非対応で原子保証できない（active 2本刺さりでstale正しさ崩壊）。そこで **部分一意索引**
```sql
CREATE UNIQUE INDEX uq_active_session ON SyncSession(project_id, origin) WHERE status='active';
```
でDBに強制する。`start` は `batch([ 期限切れactiveを expired に倒すUPDATE, 新active INSERT ])` を**1 batch（=1トランザクション）**で実行し、競合した2人目のINSERTは**一意制約違反→409**に自動変換。アプリ判定を介さずDBが原子的に1本へ絞る。

**失効の執行モデル（G4/G15）：** **遅延評価を正（プライマリ）／Cron sweepを補助（セカンダリ）**。`start`/`chunk`/`commit` の各エントリで対象 `(project_id, origin)` の active セッションに `now > expires_at` のものがあれば**その場で `expired` に倒してから**処理続行する。**スライディング失効（ハートビート・G15）:** chunk/commit の各リクエストで `expires_at` を「最終アクティビティ+10分」へ延長。正当に長い大規模commitが進行中の間は並走startに失効回収されず、衛星突然死時は最大10分でロック自動解放。

**mid-commitクラッシュの回復（G15）:** 大規模commit途中クラッシュ時の回復は**新startではなく「同一tokenでのcommit再開」**。G14で全工程を冪等にしたため同じ `:T` の再送で続きから収束する。「activeがoriginをロック」は同一originの二重プロデューサ防止として正しい挙動であり、デッドロックではない。Cron sweepは表示整合・掃除にとどめ、正しさは遅延評価が保証する。

### 4.7a. SyncStaging（commit作業領域・G14）

commit冒頭で「新規 `external_ref` → 新規 `test_case_id`（uuid）」を集合INSERTし、identity↔canonical の循環生成（FK順序）を断つ一時表。**id採番が永続化されクラッシュ再開で同一idに収束**し、commitレスポンスの `external_ref → test_case_id` マップ（§5.5・API-4）にも再利用する。

| 列 | 型 | 説明 |
|---|---|---|
| sync_token | TEXT (FK) | 対象セッション |
| external_ref | TEXT | 新規ケースの参照ID |
| new_test_case_id | TEXT (uuid) | 採番した canonical PK。`ON CONFLICT(sync_token, external_ref) DO NOTHING` で冪等 |

セッション寿命のみの一時データ。`SyncSession` 確定/失効後にパージ対象。

### 4.8. ApiToken（衛星向け・プロジェクト単位スコープ・Grill Q7）

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| project_id | TEXT (FK) | スコープ対象プロジェクト（→org）。最小権限。 |
| token_hash | TEXT | トークンの**決定的 SHA-256**（saltなし・索引付き）。高エントロピートークン前提で、Bearer受信時に **完全一致で直接シーク（O(1)）**。平文は保存しない（G6）。 |
| name | TEXT | 用途ラベル（どの衛星か） |
| last_used_at | INTEGER? | 直近利用時刻。**best-effort・非ブロッキング**（更新失敗で認証を落とさない）かつ**間引き更新**（前回更新から閾値〔例1分〕経過時のみ＝D1単一ライタ負荷を回避。D1-6）。システム可変列扱いでOCC非bump（G6）。 |
| created_at / revoked_at | INTEGER? | 発行・失効時刻 |

**生成仕様（G17/SE-A2）:** `crypto.getRandomValues` で **32バイト以上**、base64url、**識別プレフィックス付き**（例 `tms_…`）。Zodで長さ下限を検証し「高エントロピー前提」を契約化（決定的SHA-256の安全性の根拠）。
**失効の執行（G16決定3/SE-A1）:** `revoked_at` は記録列ではなく**認証述語に内包**する：`SELECT … WHERE token_hash=? AND revoked_at IS NULL`。ヒットしなければ401。失効済みトークンは「そもそも存在しない」として弾かれる。
**平文の隔離（G17/SE-B1）:** 発行レスポンスに `Cache-Control: no-store`。平文は**ログ・`TestCaseHistory`・監査・エラーボディに一切含めない**（記録は `token:<id>` のみ）。
**ライフサイクル（G6）：** 発行/一覧/失効APIは `role=admin` 限定（§5.1a）。**発行時の応答body で平文トークンを1回だけ返す**（以後は二度と取得不可、ハッシュのみ保存）。失効は `revoked_at` を打つソフト失効。lookup_id分離の二部構成はMVPでは過剰として採らない。

### 4.9. TestCaseHistory（人間の編集ログ・簡易変更履歴）

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT | PK |
| test_case_id | TEXT (FK) | 対象 |
| actor | TEXT | 実行者の**型付き参照**（`user:<id>` / `token:<id>`。自由文字列を廃止し実体に固定。G5）。なりすまし・履歴偽装を排し監査の完全性を担保。 |
| action | TEXT enum | `created` / `updated` / `status_changed` / `imported`。CHECK制約。**token actor の action は `imported` に限定**（G14でimportはsync経路のみ＝自然成立。SE-G1）。 |
| delta | JSON | 変更フィールドのみの差分 `{field: {before, after}}`。フルスナップショットではなくデルタ保存で容量・I/Oを最適化。ネスト差分が必要ならRFC 6902(JSON Patch)形式も選択肢。（REV-05） |
| created_at | INTEGER (epoch ms) | 発生時刻 |

**追記専用（G17/SE-G1）:** `TestCaseHistory` は **UPDATE/DELETE禁止の追記専用（Append-only）**。ドメイン層・DB制約の両面で不変オブジェクト化し、who/what/how のタイムラインの完全性を100%保証（パージは保持ポリシーに基づく古い行の一括削除のみ＝改竄ではない）。

### 4.10. canonical 状態機械（Grill Q1/Q2/Q5・G1/G3/G7）

`status`（**draft/approved/archived の3値**）と `ownership`（machine/human）の二軸＋直交フラグ `is_stale` / `drift` で定義する。**`stale` は status enum から外し直交 bool 化**したため、staleness は status を一切書き換えずフラグの ON/OFF だけで表現する（G3）。

```
[新規 import]
   └─▶ draft / machine-owned        … mirror_originの最新観測をcanonicalにミラー（G1）
         │  人間が編集 or 承認（最初の接触）
         ▼  ownership: machine ─不可逆─▶ human
   draft or approved / human-owned   … 以後 import は canonical の人間所有列を上書きしない
         │                               観測との指紋差は drift=true として記録のみ（G2: システム可変列のみ書く）
         │  sync commit で当該originに未出現（他オリジンも未観測）
         ▼
   is_stale = true（直交・非破壊マーク）… approved は is_stale 化しない（Q2-A保護）。statusは不変
         │  後続 sync で external_ref 再出現
         ├─▶ is_stale = false（statusは元から不変なので「復帰」処理は不要。G3）
         │  人間が確認
         ▼
   archived（人間の明示操作・ソフトデリート＝ミラー停止境界。G7）
```

- **ミラー境界（Q5/G1/G7）:** `machine`-owned **かつ非archived** の間のみ、**`mirror_origin` の**最新観測をcanonicalへミラー。人間の最初の接触で `human` 化、または人間の archive 操作で、いずれも**ミラー停止**＋drift記録へ切替（archivedはownership非依存の絶対ミラー停止境界）。
- **drift（Q1/Q8/G4/DM-H5）:** **`ownership=human` かつ 非archived時のみ**立てる（machine/archivedには記録しない＝バッジ誤発火を防ぐ）。基準は `mirror_origin` の `latest(committed観測).fingerprint != canonical.fingerprint`。`fingerprint=null`（手動作成）は未評価＝false（DM-L1）。**accept-fingerprint 操作**（最新committed観測指紋をOCC下で採用）で false（DM-H3/CC-A4）。
- **is_stale（Q2/REV-08/G3/G13）:** **真実の源は §4.5 `TestCaseIdentity.is_stale`（per-origin）**。commit時、当該origin identity を `last_seen_sync_token != 今回token` で `is_stale=true`（自originの行のみ・無競合）。canonical.is_stale は**派生キャッシュ**で、commit末尾のrollupが「**TTL以内の live identity が全て stale**」なら true（凍結originは集約除外＝永久取りこぼし解消。DM-C2）。rollup の WHERE で **`status NOT IN ('approved','archived')` を保護**（承認意思＋削除意思を同時防御。DM-M1）。判定は committed 由来のみ（G4/G15フェンス）。
- **archived の再観測（G7/DM-M1）:** archived canonical が再 sync で現れても、observation 記録のみ行い、**canonical 内容・`status=archived`・is_stale は不変**（rollupが archived を除外）。「再出現」シグナルは `archived_at` 列と identity.`last_seen_at` の比較で導出（is_stale=false との混同を回避）。アーカイブからの復帰は**人間の明示操作のみ**。identity は archive 後も**保持**し、再 sync でのゾンビ化を防ぐ。
- **ownership の re-adopt（DM-M5）:** `machine→human` は不可逆だが、誤操作（同値PATCH等で意図せず human 化→恒久ミラー停止）の救済として **admin による machine への再採用（re-adopt）操作**を用意。併せて遷移トリガを「**値が実際に変化した人間所有列のPATCH**」に限定（no-op/同値PATCHでは遷移しない）。
- **複合不変条件（DM-L2）:** approval/archive は人間操作で human 化するため `approved+machine` / `archived+machine` は本来到達不能。テーブルCHECKで **`status IN ('approved','archived') ⇒ ownership='human'`** を表明し、矛盾状態へのバグ落下を構造防止。

### 4.11. 設計上のポイント

- **Given/When/Then は人間向けナレーション（ビュー）**。同一性・drift判定は散文ではなく **behavioral-fingerprint**（衛星供給・opaque。Grill Q8）で行う。Gherkin/自然言語ビューはこの3列＋`parameters`から派生描画。
- **同一性は衛星責任・TMSは契約**：`external_ref`（同一ケース判定）も `fingerprint`（挙動変化判定）も、TMSはopaqueに扱い、安定性の責任は衛星に課す（Grill Q2/Q8で一貫）。
- **マルチホーミング（REV-08）／ミラー権威（G1）**：同定情報（origin/external_ref/last_seen）は `TestCaseIdentity` に分離。1canonicalに複数オリジンが独立同定でき、stale判定は**オリジン別**（他が観測中なら立てない）。**内容ミラー権威は単一**＝`mirror_origin` のオリジンの観測のみが canonical 内容・fingerprint を更新（複数machineオリジンの内容フラップを排除）。
- **import経路の分離（Q3／G2／G12）**：**chunk は `TestCaseObservation` への追記専用**（last_seen/identity/canonical/ミラー/staleには触れない。G12）。canonical のシステム可変列・identity の last_seen・ミラー昇格・stale判定は**すべて commit 時の述語駆動集合文**（§5.2の8工程）で書く（人間所有列は不可侵・OCC version非bump）。`machine`-owned かつ非archived かつ `mirror_origin` 一致のときのみ観測を canonical へミラー昇格（ownershipガード相関UPDATE単一文・CC-A1）。
- **テナント境界（Q7）**：`Storage` インターフェースの全メソッドが orgScope を要求するシグネチャ。全クエリをorgで絞り、越境をコンパイル時に防止。APIトークンは project スコープ、`:pid` のorg不一致は403。
- **JSON列のフィルタ最適化（REV-11）**：`metadata`/`parameters` を高頻度フィルタ条件にする場合、対象プロパティ（例 `tags`）を **SQLite Generated Column（STORED/VIRTUAL）に切り出し索引**を張る（D1ネイティブ機能。Drizzleで定義）。フルテーブルスキャンを回避。
- **Zodスキーマを単一の真実の源**とし、API入力検証・DBモデル・型を一元化（Drizzleと連携）。
- SQLite方言に閉じることで、D1⇔libSQL⇔better-sqlite3 でスキーマ・SQLを共通化。
- インデックス: `(project_id, status)`, `(project_id, category)`, `(project_id, is_stale)`・`(project_id, drift)`（バッジ抽出用。G3）, `ApiToken(token_hash)`（O(1)認証。G6）, Identity側 `(project_id, origin, external_ref)`（一意・同定用）・`(project_id, origin, last_seen_sync_token)`（stale判定用）・`(test_case_id, is_stale, last_seen_at)`（canonical rollup集約用。G13）, Observation側 `(test_case_id, created_at)`・`(project_id, sync_token)`・**一意 `(external_ref, origin, sync_token, fingerprint)`**（冪等INSERT。G14）, SyncSession側 **部分一意 `(project_id, origin) WHERE status='active'`**（一意性DB委譲。G15）・`(token, status)`（committed-JOINフェンス用）, 生成列索引（REV-11）。
- **enum の二重防御（G10）:** SQLiteにenum型は無い。`status`/`category`/`ownership`/`role`/`action` 等の**安定列はCHECK制約＋Zod**で二重に縛る。一方 `origin` やメタ分類のように将来値が増える列は CHECK を外しZodのみとし、ALTER頻度を抑える。
- **楽観的排他制御（OCC, REV-01／G2）:** human操作の並行更新を防ぐ。PATCHは `version` 一致を要求し、不一致時は 409。**versionは人間所有列の更新でのみbump**し、importのシステム可変列更新では bump しない。
- **パラメータ化テスト（REV-02）:** `given/when/then` は代表シナリオ、入力値・期待値のバリエーションは `parameters` 配列に構造化保持。
- **履歴のデルタ保存＋保持ポリシー（REV-05）:** 変更フィールドのみ記録。保持期間／件数上限でコンパクション（既定値は実装計画で決定）。

---

## 5. API設計

すべてZodで検証。UIもこのドメイン層を共有（API/UIで二重実装しない）。レスポンスは**統一エラースキーマ**（§5.5・安定code付き）。全パスは **`/api/v1/...`**（バージョニング・G18）。**全リソースを project 配下に階層化**しIDORを構造防止（G16決定1：フラットパス `/api/testcases/:id` を廃止）。

### 5.1. 参照・操作系（UIと共有）

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/v1/projects` | プロジェクト一覧 |
| POST | `/api/v1/projects` | プロジェクト作成（admin） |
| GET | `/api/v1/projects/:pid/testcases` | テストケース一覧（`status`/`category`フィルタ、**カーソルページング** §5.5） |
| POST | `/api/v1/projects/:pid/testcases` | テストケース作成（手動・editor） |
| GET | `/api/v1/projects/:pid/testcases/:id` | 単体取得（現version を弱ETagで返す） |
| PATCH | `/api/v1/projects/:pid/testcases/:id` | 編集（status変更含む・editor・**`If-Match` でOCC version**） |
| DELETE | `/api/v1/projects/:pid/testcases/:id` | **archive固定**（status=archived・editor）。物理削除は提供しない（identity消滅→ゾンビ復活を招くため。API-10/G7） |
| GET | `/api/v1/projects/:pid/testcases/:id/history` | 変更履歴 |
| GET | `/api/v1/projects/:pid/testcases/:id?format=gherkin` | Gherkin/自然言語ビューを派生生成 |

各ルートには**能力メタデータ**（許可認証方式・最低role）を宣言し、共通ミドルウェアが機械的に執行する（§5.4）。

### 5.1a. トークン管理API（admin限定・G6）

| メソッド | パス | 用途 |
|---|---|---|
| POST | `/api/v1/projects/:pid/tokens` | トークン発行。**応答bodyで平文を1回だけ返す**（`Cache-Control: no-store`、以後取得不可、ハッシュのみ保存）。`role=admin` 限定。 |
| GET | `/api/v1/projects/:pid/tokens` | 一覧（id/name/created_at/revoked_at/last_used_at のみ。平文・ハッシュは返さない）。 |
| DELETE | `/api/v1/projects/:pid/tokens/:id` | 失効（`revoked_at` を打つソフト失効）。`role=admin` 限定。 |

### 5.2. 衛星サービス向け取り込みAPI（★ハブの肝・同期セッション方式）

単発Upsertではソース側で削除されたテストケースがTMSに残り続ける（オーファン化）。これを防ぐため、取り込みを**「同期セッション」**として設計する（REV-03）。**最上位方針（G12）：chunk は観測の追記専用、canonical変異・同定・ミラー・stale はすべて commit 時の述語駆動集合文に集約**（「commitされるまで本尊に触れない」をG4の書き手側に貫通）。

| メソッド | パス | 用途 |
|---|---|---|
| POST | `/api/v1/projects/:pid/sync/start` | 同期セッション発行。`origin` を指定。応答 `{ sync_token, expires_at, server_time, max_chunk_size }`（API-2）。一意性は**部分一意索引**でDB委譲し、`batch([期限切れactive→expired, 新active INSERT])` で競合2人目を制約違反→**409 `DUPLICATE_SYNC_SESSION`**（CC-B1/G15）。 |
| POST | `/api/v1/projects/:pid/sync/:token/chunk` | **観測の追記専用**（G12）。各観測を `TestCaseObservation` へ **`(external_ref,origin,sync_token,fingerprint)` 一意制約＋`ON CONFLICT DO NOTHING` で INSERT**（指紋が `(test_case_id|external_ref, origin)` 単位で変化した時のみ＝変化点。DM-H6）。**canonical/identity/last_seen/ミラー/staleには一切触れない**。D1上限（D1-1）対応で **1 INSERT文 ≤16行**のバルクを `batch()` に積む（chunkサイズ既定 ≤500観測・byte上限Zod検証 D1-7）。応答 `{ accepted, received:[{external_ref, outcome}] }`（`test_case_id` はcommitで返す。API-3）。 |
| POST | `/api/v1/projects/:pid/sync/:token/commit` | **冪等に再開可能なバッチcommit**（8工程・全工程set-based＆冪等。G14）。応答 `{ status, staled_count, processed_cursor, more, mappings:[{external_ref, test_case_id, outcome}] }`（`more:true` の間 同一token再commit＝G9/G14。API-4）。大規模時は工程3〜7を `LIMIT` ウィンドウで分割（同一token再送で続きから収束）。 |

**commit の8工程パイプライン（§5.2の正式仕様・G14）：** 対象セッション `(P, O, T)` について、すべて set-based・冪等。

| 工程 | 文（要旨） | 冪等ガード |
|---|---|---|
| 0 同定採番 | `SyncStaging` に新規 `external_ref → 新uuid` を集合INSERT | `ON CONFLICT(sync_token,external_ref) DO NOTHING` |
| 1 canonical生成 | Staging→`TestCase`（`draft`/`machine`/`mirror_origin=O`/seed列） | `NOT EXISTS TestCase` |
| 2 identity生成 | Staging→`TestCaseIdentity` | `ON CONFLICT(project_id,origin,external_ref) DO NOTHING` |
| 3 last_seen確定＋再出現 | `UPDATE identity SET last_seen_*=…, is_stale=0 WHERE 観測有` | is_stale=0 は冪等 |
| 4 stale mark（per-origin） | `UPDATE identity SET is_stale=1 WHERE origin=O AND last_seen_sync_token!=:T` | is_stale=1 は冪等 |
| 5 ミラー昇格 | ownershipガード相関UPDATE単一文（`WHERE ownership='machine' AND status NOT IN ('archived') AND mirror_origin=:O`） | WHERE述語で自然冪等（CC-A1） |
| 6 drift記録 | `UPDATE TestCase SET drift=1 WHERE ownership='human' AND status!='archived' AND fingerprint!=(mirror_origin最新committed指紋)` | drift=1 は冪等 |
| 7 canonical rollup | `UPDATE TestCase SET is_stale=(TTL内live identityが全stale) WHERE status NOT IN ('approved','archived')` | 純関数で冪等 |
| 8 セッション確定 | `UPDATE SyncSession SET status='committed'` を**全工程完了後**に | 最後の1文 |

- 小規模セットは start→1 chunk→commit を **1 batch()=1トランザクションで完全原子**（torn state を発生させない。G15）。大規模のLIMITウィンドウは **committed-JOINフェンス**（`status='committed' OR token=:T`）で他originの未確定half-writeを判定から遮断し、rollupを「committed状態の純関数」化＝順序非依存に収束（CC-B2/C2/G15）。
- stale判定は `TestCaseIdentity` の `(project_id, origin, last_seen_sync_token)` インデックスで効率化（観測テーブルを走査しない。Q6/REV-08）。判定はSQLの述語に押し込みWorker CPUを消費しない（G9）。set-based のためバインドは定数個で `bind=100` 上限を踏まない（D1-1）。
- `UPDATE … LIMIT` は **D1サポート済**（D1-5）。冪等収束の必要条件として **`WHERE is_stale=0 AND …`（未処理行のみ選択）** を前提とし、§8.1 契約テストで移植先（libSQL/better-sqlite3）の互換を機械検証。
- 失効・未commitセッションの観測は **canonicalに昇格しない**（孤立 observation が残るだけ＝G4境界が無視・G11パージが回収）。drift/stale/Diffが見る観測は **committed由来のみ**（G4/G15）。
- **chunk再送の冪等性：** observation の一意制約＋`ON CONFLICT DO NOTHING`、および commit の全工程冪等により、ネットワーク再送・並行二重処理は構造的に冪等（CC-D1）。明示契約として `Idempotency-Key` ヘッダも受ける（§5.5・多重防御）。

### 5.3. 認証・テナント境界・流量制御

- **APIトークン**（衛星サービス用）と**セッション**（UI用・§4.2b `Session`）を分離。取り込み／同期APIはトークン認証必須。トークンは**決定的SHA-256＋索引で直接照合**（O(1)。G6）。発行/失効は `role=admin` 限定（§5.1a）。
- **テナント境界の強制（Grill Q7）:** トークンは **project スコープ**（→org）。ミドルウェアで「トークンのproject == `:pid`、かつ同一org」を検証し、不一致は **403**。`Storage` の全メソッドは orgScope を必須引数とし、越境クエリを構造的に不可能にする。
- **レートリミット（REV-06／G8／D1-2修正）:** `RateLimiter` インターフェース（第4のポータビリティ境界）越しにトークン別制限。**CF実装は公式 Workers Rate Limiting binding（2025-09 GA）を採用**：同一ロケーションのバッキングストアへ非同期同期され、イソレート跨ぎにネットワーク待ちなしで効く。**旧「イソレート単位インメモリ」案は撤回**（同一キーが複数イソレートに分散・頻繁リサイクルで実効性が無いという事実誤認のため。D1-2）。bindingは `RateLimiter` ポート裏に注入し、オンプレはプロセス内/Redisアダプタへ差し替え（移植性維持）。位置づけは「best-effort・eventually consistent」。**D1にカウンタ行を置く方式は単一ライタ自己圧迫のため不採用**。
- **書き込み頻度の自衛（G11）:** opaque契約を壊さず、単位時間あたりの変化点記録（insert）頻度の異常を RateLimiter で検知・ブロックし、衛星の fingerprint 暴走による D1 容量爆発を防ぐ。
- **認証ブルートフォース防御（G16決定5／SE-H1）:** ログイン／認証失敗は**衛星トークン用の流量制限とは別立て**で、**`(account, IP)` 別の永続カウンタ**（D1 or CF Rate Limiting binding）でロックアウト＋指数バックオフ。未認証の高頻度試行（パスワード総当たり・クレデンシャルスタッフィング）を物理停止し、認証失敗イベントを**変更履歴と隔離した認証監査**に記録。
- **サーキットブレーカー（REV-06, 将来）:** 異常な失敗率・流量を検知したトークンを一時遮断する機構を将来追加（MVPはレート制限のみ）。

### 5.4. 認証・認可ミドルウェア執行仕様（G16・RC-3）

データモデルがどれだけ精緻でも、境界面（ミドルウェア）の執行が甘ければ崩壊する。SyncSession に明示的執行モデル（G4/G15）があるのと同じ水準で、**「各パス×認証方式×必要role×テナント突合×失効チェック」を1つの執行マトリクスとして固定**する。

**決定1: パス階層化＋id→org解決でIDOR構造防止（SE-E1）。** フラットパスを廃止し全リソースを `/api/v1/projects/:pid/...` 配下へ。共通前段ミドルウェアが **`id → project_id → organization_id` を1クエリ解決**し、リクエスタのスコープと不一致なら **404（存在隠蔽＝列挙攻撃の無効化）**。検証済みscopeを downstream に注入（ハンドラ個別の認可漏れを根絶）。

**決定2: 2認証方式の到達面分離＝能力マトリクス（SE-F2/E2）。**

| 主体 | 認証 | 到達可能 | 禁止（→403） |
|---|---|---|---|
| **衛星トークン** | Bearer（project scope・role無し） | `POST /sync/*`、自projectの参照系GET | testcase PATCH/DELETE/status変更・token管理・project作成 |
| **UIユーザ** | セッションCookie（org scope・role有り） | role準拠のCRUD・status・archive・token管理 | 他org・role超過（→403/404） |

importの不可侵（Q3/G2/G14）を**API表面のallowlistで一次防御**（chunk処理ロジックの内側だけに頼らない）。各ルートに能力メタデータ（`{schemes, minRole}`）を型付き宣言し、ミドルウェアが機械執行。

**決定3: 失効・有効性を認証述語に内包（SE-A1）。** トークン＝`WHERE token_hash=? AND revoked_at IS NULL`、セッション＝`WHERE id=? AND expires_at > :now`。「**署名検証 → DB存在 → 未失効**」の三段ANDを共通関数化し全保護ルートが必ず通る（記録列でなく執行点に）。

**決定4: ルートメタデータ駆動RBAC（SE-F1）。**

| 操作 | 最低role |
|---|---|
| 参照系GET | viewer |
| testcase 作成/編集/status変更/archive | editor |
| token発行/失効・project作成・user管理 | admin |

**決定5: 認証ブルートフォースは専用の永続スロットル（SE-H1）。** §5.3 に記載（衛星トークン用の流量制限とは主体も目的も分離）。

### 5.5. API契約（衛星向けインタフェース正本・G18・RC-3）

衛星3種（Discovery/TestGen/SelfHealing）が実装着手できる契約水準を確定する。**Zodスキーマを正本**とし、OpenAPI相当を生成。

**統一エラースキーマ（API-1）:**
```json
{ "error": { "code": "...", "message": "...", "details": [{"path":"...","msg":"..."}], "retryable": false } }
```
`code` 安定enum: `VALIDATION_FAILED`(422) / `OCC_CONFLICT`(409) / `DUPLICATE_SYNC_SESSION`(409) / `CROSS_TENANT`(403/404) / `NOT_FOUND`(404) / `SESSION_EXPIRED`(410) / `RATE_LIMITED`(429) / `UNAUTHORIZED`(401)。**409の二義性を code で分離**し衛星の自動回復分岐を成立させる。

**バージョニング（API-9）:** `/api/v1/...`。任意フィールド追加は非破壊（同一版）、必須追加/改名/削除は新版でのみ、未知フィールドは Zod `strip`。

**同期API戻り値（API-2/3/4）:** §5.2 の各表に定義。`start`→TTL/サイズ通知、`chunk`→受領エコー、`commit`→確定マッピング＋再開フラグ。成功コード: 作成=201、部分完了commit=**202**、完了commit=200。

**chunk リクエスト＝Observation スキーマ（API-5/6/7）:**
- 1観測 `{ external_ref(必須), fingerprint(必須), observed(必須), confidence?, source_ref? }`。`origin` は start で指定済み＝各件では受けない（揺れ防止）。
- `observed` は**固定キーセット** `{given, when, then, parameters, source_ref, schema_version}`（`schema_version` で構造化Diffのバージョン跨ぎを区別＝衛星更新時の偽陽性回避。API-6）。
- `external_ref`/`fingerprint` は **長さ≤512・printable ASCII**（索引肥大＝D1 10GB圧迫を防ぐ。API-7）。chunk全体に**バイトサイズ上限**（行2MB上限。D1-7）。

**冪等・OCC・DELETE・ページング・PATCH（API-8/10/11/12/14）:**
- `Idempotency-Key` ヘッダ（chunk/commit・短期メモ化＝G12-G15の構造的冪等への多重防御）。
- OCC は **`If-Match: "<version>"`** で渡し、GET/PATCH応答は現versionを弱ETagで返す。
- DELETE = **archive固定**（物理削除は提供しない。API-10/G7）。
- ページングは**カーソルベース**（`(created_at, id)` 安定タイブレーク）、`{ items, next_cursor, has_more }`。`total` は重い場合は任意/概算。
- PATCH は「**キー存在=更新／未指定=不変／明示null=クリア**」を明文化。

**値ドメイン・表現（API-15/16/17）:**
- `origin` 正規化規則（小文字・許可文字・既知プレフィックス推奨）＝mirror権威/stale判定の完全一致依存を守る。
- 日時は全API JSONで **epoch ms 数値**（内部と一致）。`?format=gherkin` の Content-Type を明記。
- 全コレクション応答を `{ items, ... }` に統一（将来ページング追加を非破壊化）。

---

## 6. UI（素朴・最小JS）

Hono JSXのSSR＋HTMXで部分更新。画面は3つ：

1. **プロジェクト一覧/作成** — 一覧＋新規フォーム。
2. **テストケース一覧**（プロジェクト配下） — テーブル表示。`category`/`status`フィルタ、検索。各行クリックで詳細。HTMXでフィルタ部分更新。
3. **テストケース詳細/編集** — Given/When/Thenの構造化フォーム＋`status`変更＋紐づくidentity（origin/external_ref）/`source_ref`表示＋「Gherkinビュー」タブ＋変更履歴。**`drift` バッジ**（human-ownedで観測と乖離）と **`is_stale` バッジ**（コード側で消えた候補・canonical集約。G3/G13）を表示。is_staleバッジは**どのoriginがstaleかを per-origin の `TestCaseIdentity.is_stale` でドリルダウン表示**（真実の源はidentity・G13）。`drift` 解消は **accept-fingerprint 操作**（最新committed観測の指紋採用・OCC下。DM-H3）の導線を置く。archived だがコード側に再出現したケースには `archived_at` と `last_seen_at` 比較による「再出現」シグナルを出す（G7/DM-M1）。
   - **構造化Diffビュー（REV-09）:** driftの「何がどう変わったか」を、canonical（現在の正）と `latest(TestCaseObservation).observed` の **構造化JSON Diff を TMS側で計算・描画**する。指紋はopaqueなまま「検知」に徹し、「説明」は保存済みスナップショット同士の差分で行う（衛星には差分計算を要求しない）。

差分計算ロジックはTMSドメイン層に置く（純粋関数・単体テスト可）。drift解消・stale/draftのマージ等のリッチな承認操作は後続（HITL実装時）。MVPは「drift/staleの可視化＋構造化Diff表示」までで、整合操作は手動status変更で代替。

**制約：リアルタイム同期（REV-07）。** バックグラウンドでサテライトがステータス等を変更しても、HTMXの部分更新はユーザがアクションするまで最新化されない。MVPではこれを許容し、一覧画面に手動リフレッシュ、必要なら HTMX のポーリング（`hx-trigger="every Ns"`）を任意で用意する。将来的に SSE（Server-Sent Events）による状態のリアルタイム同期を導入する余地を残す。

---

## 7. 認証（最小）

- **UI:** 簡易セッション（単一組織・少人数想定の最小ログイン）。**ユーザは §4.2a `User` を第一級**で持ち（org スコープ・`role`）、パスワードは **PHC string形式（PBKDF2-SHA256 600,000回・per-userソルト）** で `Auth` 裏に隔離し、ログイン時透過再ハッシュでargon2へ無停止移行可（G5/G17）。セッションは **§4.2b `Session`（D1/SQLite上）**＋署名付きCookie（`HttpOnly; Secure; SameSite=Lax`・鍵IDローテ・ログイン時ID再発行）で KV依存を避けポータビリティ維持。状態変更にCSRF（double-submit）。Cloudflare Accessは「使うなら前段の任意オプション」で、本体は依存しない（＝オンプレ移植性を維持）。
- **API（衛星）:** プロジェクト単位のAPIトークン（ヘッダ `Authorization: Bearer ...`・32B CSPRNG・識別プレフィックス）。**決定的SHA-256＋索引で直接照合**、失効は認証述語に内包（G6/G17）。発行/失効は admin 限定。
- **認証・認可の執行点は §5.4 の執行マトリクスに集約**（パス×認証方式×role×テナント突合×失効。RC-3）。
- 認証ロジックも `Auth` インターフェースとして抽象化し、オンプレでは別IdP差し替え可能に。
- **テナント境界は論理的に最初から全データアクセスへ通す（Grill Q7）。** `Organization` を第一級・`Project.organization_id` 必須FK、`Storage` 全メソッドが orgScope を要求、トークンは project スコープで越境403。MVPは単一orgをseedして運用するが、コードパスは常にorgを通す。**物理的なテナント分離（テナント別D1等）は将来の最適化**でアダプタ裏に隠す。

---

## 8. テスト方針・パフォーマンス最適化

### 8.1. テスト方針

- **TDD前提**。ドメイン層は純粋関数中心で、Storageをモックして単体テスト。
- **テストランナー:** Vitest（Workers環境は `@cloudflare/vitest-pool-workers` でD1含め統合テスト）。
- **Storageアダプタは契約テスト**（同一テストスイートをD1/libSQL両実装に通し、移植性を機械的に保証）。**`UPDATE … LIMIT` / `DELETE … LIMIT` の互換チェックを契約テストに含める**（D1はサポート済だが、古いlibSQL/SQLiteビルドで `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` 無効だと同一SQLが動かないため。D1-5）。

### 8.2. パフォーマンス評価の結論

CRUDワークロードはI/Oバウンドであり、体感レスポンスはコールドスタート・エッジ配置・DB I/Oが支配的。アプリのCPU処理は全体の数%以下のため、実装言語の変更による体感改善はほぼゼロ。Cloudflare Workers + TypeScript + Hono は既に体感速度の最適解であり、かつオンプレ移植性も両立する。

### 8.3. 標準採用の最適化（移植性非破壊）

- インデックス設計（§4.11。canonical/identity/observation/生成列）。
- SSR＋HTMXで最小ペイロード。
- エッジ配置（Workers既定）。

### 8.3a. DB容量・肥大化対策の運用要件（REV-10）

長期的に `TestCaseObservation`／`TestCaseHistory` は（変化点・デルタ化しても）増大する。SQLiteは行DELETEだけではファイルが縮まらずフラグメンテーションが進む。これを**ポータビリティ境界で分けて**対処する。

- **共通（必須要件）:** 保持ポリシー（直近N変化点／T日）に基づく**定期パージ**。**「MVPは上限なし」は撤回し、時間基準の既定値をMVPから設定**（例：committed観測90日。件数基準Nは実測後。G11）。クラウドは **Cloudflare Cron Triggers の scheduled Worker**、オンプレは cron/スケジューラで、`Storage` 裏の同一パージ操作を呼ぶ。**不変条件：各 `(test_case_id, origin)` につき直近 committed 観測を最低1件は必ず残す**（per-origin強化・drift/Diffの足場。G11/DM-M4）。**パージは `DELETE … LIMIT N` の小バッチ反復**（削除・残置の両述語に `status='committed'` フィルタ＋最低1件保持WHERE）。1 Cron実行のクエリ数を1,000未満に抑え、複数実行に分割継続して **30秒/数十万行の実行上限と単一ライタ長時間占有を回避**（D1-3／commitの冪等バッチと同型）。
- **D1（クラウド）:** D1は **`VACUUM`/`auto_vacuum` を公開PRAGMAに持たず**、物理リクラメーションを**自前管理**する（容量超過時の公式対処も「行DELETE or DB分割(shard)」）。**D1は1データベース10GBの物理ハード上限**を持つため、Cronで容量を概算監視し、しきい値到達前に**警告／shard判断**を行う運用要件を置く（上限到達は全書き込み拒否＝即死。G11）。**shardの単位（D1-4修正）:** 容量肥大の真因は `TestCaseObservation`/`TestCaseHistory` の**単一org・単一project内でも起きる時系列増加**であり、`Organization` 別分割（§7の論理テナント境界・将来最適化）では解決しない。よって容量shardの単位は **project別／時間レンジ別D1**と定義し、テナント分離とは**別軸**で扱う。第一義の容量対策は**定期パージ＋上限監視**。
- **オンプレ（libSQL/better-sqlite3）:** こちらは `PRAGMA auto_vacuum=INCREMENTAL`（DB初期化時・テーブル作成前に設定）＋ 定期 `PRAGMA incremental_vacuum` が**有効**。アダプタ初期化・パージ後に実行し、ファイルサイズを回収。
- ＝「**定期パージは共通要件、VACUUMはオンプレアダプタ専用の実装詳細**」とし、アプリ本体はパージ操作のインターフェースのみ知る。

### 8.4. オプション最適化（アダプタ裏に隔離、CF固有）

- Cache API / KV による読みキャッシュ（アダプタ裏に隔離）。
- Smart Placement（WorkerをD1の近くに自動配置）。**これはアダプタ裏のコードでなく Worker のランタイム設定**（`placement = { mode = "smart" }`）であり、ポータビリティ境界の対象外（オンプレでは設定不在になるだけ。D1-8）。
- **書き込み直列化キュー（REV-04, 将来フック）:** D1(SQLite)は単一ライタのため、サテライトからの超高頻度バッチWriteは書込競合（BusyTimeout）を招き得る。将来、サテライトとD1の間に **Cloudflare Queues** を挟み、Writeをバッチ・直列化するアーキテクチャを採れるよう、取り込み経路を**Storage/Ingestインターフェースの裏**に閉じておく。Queuesは**CF固有**のため、オンプレでは別キュー（or 直接Write）に差し替え可能とし、ポータビリティ境界を越えさせない。MVPでは実装せず、設計記載のみ。

### 8.5. スキーマ・マイグレーション戦略（G10）

- **単一ソース:** Drizzle Kit をスキーマ定義＋マイグレーションの **Single Source of Truth** とし、生成される **SQLマイグレーションファイルは3アダプタ共通**。適用ランナーのみ環境別：クラウド=`wrangler d1 migrations apply`、オンプレ=Drizzle migrator（better-sqlite3/libSQL）。データ構造の変遷履歴まで共通化し環境間の等価性を機械的に保証。
- **環境固有PRAGMAの隔離:** `PRAGMA auto_vacuum=INCREMENTAL` 等の「テーブル作成前・空DB時」に発行必須の設定は**共通マイグレーションに書かず**、オンプレアダプタの**接続初期化フック**（DBオープン直後）で発行。D1では no-op。共通SQL資産を汚さず §8.3a の前提条件を満たす。
- **enum:** 安定列（status/category/ownership/role/action）は **CHECK制約＋Zod** の二重防御。流動列（origin・メタ分類）は CHECK を外しZodのみで ALTER 頻度を抑制。
- **生成列の昇格（REV-11）:** `metadata.tags` 等のホットフィルタを Generated Column＋索引へ昇格するのは後付けマイグレーションで運用中DBに適用可能（D1ネイティブ）。手順を実装計画で定義。

---

## 9. 今回のスコープ外（後続サブプロジェクト）

- HITL承認ワークフロー＋差分比較UI（③）。
- Discovery衛星サービス（純LLM方式 → 静的解析グラウンディング）。
- Agentic Test Generation 衛星サービス（JUnitコード生成＋`@TestCaseId`付与）。
- Self-Healing 衛星サービス（CI連携・自動修復PR）。
- 本格的なマルチテナント分離（テナント別D1への物理shard等）。
- `GeneratedArtifact(test_case_id, …)` テーブル（Test Gen衛星が生成コード・カバレッジを canonical.id へ逆参照。REV-08で整理）。
- サーキットブレーカー（REV-06）。

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
| Q3 | 観測を `TestCaseObservation` に分離し、importはcanonicalを物理的に触らない | canonical（人間の正）の不可侵を保証 | §4.6 観測テーブル、§4.11、§5.2 chunk |
| Q4 | `sync_token`タグ＋同一origin単一能動セッション（重複`start`は409） | セッションまたがり・同時実行でのstale誤爆 | §4.6 SyncSession、§5.2 |
| Q5 | ownership二軸（machine/human）。人間の最初の接触で不可逆にhuman化 | ミラー停止境界の曖昧さ／編集途中の消失 | §4.4 `ownership`、§4.9 状態機械 |
| Q6 | 変化点のみ観測記録＋identityに軽量`last_seen`。保持は実測後 | 観測時系列の爆発とD1物理上限 | §4.5 `last_seen_*`（identity）、§4.6、§8.3a |
| Q7 | テナント境界を今通す（org必須FK＋Storage orgScope）。トークンはproject単位 | SaaS化時のretrofit地獄、越境アクセス | §4.2/4.3 org、§5.3、§7 |
| Q8 | behavioral-fingerprintで比較（衛星供給・opaque）。散文はビュー | LLMの言い回し揺れがdrift/変化点をノイズ化 | §4.4 `fingerprint`、§4.10、§5.2 |

**一貫する設計原則（Grillで明確化）:** 「同一性・挙動変化の判定（`external_ref` / `fingerprint`）は衛星の責任、TMSはopaqueに扱い安定キーの契約だけ定義する」。これにより、TMSは普通のCRUD＋境界制御に徹し、AI由来の不確実性をハブから締め出す。

**注:** §10/§11の一部の節番号参照は反映当時のもの。最新のデータモデル節番号は §4.2〜§4.11（4.5 TestCaseIdentity 追加により繰り下がり）。

---

## 12. レビュー反映（2026-06-26・REV-08〜11）

一次情報（Cloudflare D1ドキュメント）で挙動を検証のうえ判定。

| ID | 指摘優先度 | 判定 | 反映 |
|---|---|---|---|
| REV-08 | 致命的→**高**に調整 | **採用（構造変更）＋根拠修正** | 同定情報を `TestCaseIdentity` に分離しマルチホーミング対応（§4.4/§4.5/§4.11/§5.2）。stale判定をオリジン別に。Test Genのカバレッジ連携は*逆参照*であり別概念→将来 `GeneratedArtifact`（§9） |
| REV-09 | 高 | **採用** | canonical vs `latest(observation).observed` の構造化JSON DiffをTMS側で計算・描画。指紋は検知専用のまま（§6） |
| REV-10 | 高 | **採用（懸念）＋メカニズム修正** | 定期パージ要件を共通化（Cron Worker/cron）。**D1はVACUUM非対応**（公式対処はDELETE/shard）→D1はパージ＋shard、`auto_vacuum/incremental_vacuum`は**オンプレアダプタ専用**（§8.3a） |
| REV-11 | 中 | **採用** | ホットなJSONフィルタ条件を Generated Column＋索引へ昇格（D1ネイティブ。§4.11） |

**検証で訂正した点：**
- **REV-08:** 指摘の主例（Test Genがカバレッジ追記）は*同定*ではなく canonical.id への*逆参照*。identity分離は「複数のDiscovery系プロデューサが同一ケースを独立Upsertする」ためのものと再定義し、Test Gen連携は別テーブルへ。副次的に**マルチオリジンのstale判定の正しさ**（他オリジンが観測中なら stale 化しない）も獲得。
- **REV-10:** 提案の `PRAGMA auto_vacuum` は **D1では無効**（D1はストレージを自前管理し、`VACUUM` を公開していない／容量超過の公式対処は行DELETEまたはshard）。よってD1のレバーは「定期パージ＋テナントshard」、`auto_vacuum/incremental_vacuum` はlibSQL/better-sqlite3（オンプレ）アダプタ専用の実装詳細として分離した。

---

## 13. 第2次Grilling反映（2026-06-26・中低リスク含む・G1〜G11）

REV-08のマルチホーミング導入後に開いた枝、および前回の単一オリジン前提では露呈しなかった中低リスクを1問ずつ確定。**本セッションは途中段階**（さらに掘る枝が残る）だが、ここまでをデータモデル・API・認証・運用に反映済み。

| G | 確定事項 | 解いた問題 | 主な反映先 |
|---|---|---|---|
| G1 | machine-owned canonicalの**ミラー権威を単一化**（`mirror_origin`列）。他オリジンは台帳のみ | マルチホーミング時の内容フラップ（last-writer-wins非決定性） | §4.4 `mirror_origin`、§4.10、§5.2 chunk |
| G2 | canonical列を**人間所有/システム可変に二分**。OCC versionは人間所有列のみbump、importは列ターゲットUPDATE | 「不可侵」の曖昧さ／背景sync中の理不尽409・ロストアップデート | §4.4 二分定義、§4.11 OCC、§5.2 chunk |
| G3 | `stale`をstatus enumから外し**`is_stale`直交フラグ化**（statusは3値純化） | 状態機械の層違反（直前status復帰が履歴パージに依存） | §4.4 `is_stale`、§4.10、§6 バッジ |
| G4 | セッション失効は**遅延評価が正/Cron補助**。drift/stale/Diffは**committed由来のみ** | クラッシュ後の同期デッドロック／未確定観測の判定汚染 | §4.6、§4.7、§5.2 |
| G5 | **User/Session第一級**＋WebCrypto PBKDF2＋型付きactor＋D1セッションストア | UIユーザ実体不在・承認権威の非帰属・監査形骸化 | §4.1、§4.2a/§4.2b、§4.9 actor、§7 |
| G6 | ApiTokenライフサイクルAPI（admin限定・平文1回提示）＋決定的SHA-256照合＋`last_used_at` | トークン発行/失効の口が無い・全行スキャン照合・幽霊トークン | §4.8、§5.1a、§5.3 |
| G7 | **archived=ownership非依存の絶対ミラー停止境界**。再観測は記録のみ・identity保持 | 人間の削除意思の機械的無視（再ゾンビ化） | §4.4 `status`、§4.10、§5.2 chunk |
| G8 | **RateLimiterを第4のポータビリティ境界**に。MVPはイソレート単位ベストエフォートと明記 | Workers分散でインメモリ制限がN倍化・移植性破壊 | §3.2、§5.3、§8.4 |
| G9 | commit stale判定は**集合UPDATE 1文**＋**冪等に再開可能なバッチ**。chunkに件数上限 | D1のインタラクティブTX非対応・1リクエスト上限での破綻 | §5.2 commit/chunk |
| G10 | Drizzle Kit単一ソース＋適用ランナー環境別。PRAGMAはアダプタ初期化フック。enumはCHECK＋Zod | マイグレーション戦略・初期化順序依存PRAGMA・enum表現の欠落 | §4.11、§8.5 |
| G11 | 保持の時間基準既定値をMVPから（90日）＋**D1 10GB上限監視**＋**最低1観測保持**＋頻度異常自衛 | 「上限なし」と「パージ必須」の矛盾・容量即死・fingerprint暴走 | §4.6、§5.3、§8.3a |

**注（旧参照の読み替え）:** §10/§11/§12 中の `status=stale` 表記は G3 により **`is_stale`（直交フラグ）** に読み替える。`stale 化` は `is_stale=true`、`stale 解除` は `is_stale=false` を指す。status enum は draft/approved/archived の3値。

---

## 14. 第3次Grilling反映（2026-06-27・独立5観点レビュー → G12〜G18）

Grilling非関与の独立レビュア5観点（データモデル/並行制御/D1制約/セキュリティ/API契約・アドバーサリアル）を起動し、3つの構造的盲点（RC）を検出。レビュー報告書は `2026-06-26-tms-web-service-design-review.md`。

**根本原因（横断テーマ）:**
- **RC-1 D1の check-then-act 非原子性** — 「SELECT→分岐→UPDATE/INSERT」がインタラクティブTX非対応で原子化不能。
- **RC-2 per-origin 概念の取りこぼし** — マルチホーミング（REV-08）後も is_stale/drift/last_seen が canonical単一値のまま。
- **RC-3 境界面の薄さ** — 認証執行仕様とAPI契約が独立した節として不在。
- **RC-4 committed境界の片側適用** — G4を読み手にだけ課し書き手に未適用。

| G | 確定事項 | 解いた問題 | 主な反映先 |
|---|---|---|---|
| G12 | **chunkは観測のappend専用**、canonical変異を全て commit の述語駆動集合文へ集約 | 未commit昇格 vs G4衝突（ゾンビcanonical）・RC-1/RC-4 | §4.4/§4.6/§5.2 |
| G13 | **is_stale を identity粒度へ降格**＋canonical stored rollup＋TTL付き「全liveオリジンstale」集約 | per-origin staleness 表現不能・凍結origin取りこぼし（RC-2） | §4.4/§4.5/§4.6/§4.10 |
| G14 | **ステージング表＋ownershipガード相関UPDATE単一文＋chunk≤16行INSERT＋8工程冪等パイプライン** | 人間初編集の無音上書き（CC-A1）・chunk非冪等・D1 bind/queries上限 | §4.7a/§5.2 |
| G15 | **部分一意索引／committed-JOINフェンス／同一token再開＋スライディング失効** | セッション一意性原子保証不能・torn可視化・rollup順序依存・mid-commitデッドロック | §4.7/§5.2 |
| G16 | **認証・認可執行マトリクス**（パス階層化＋id→org404／能力マトリクス／失効述語内包／RBAC／ブルートフォース） | 失効トークン素通り・IDOR・トークン越権・viewer越権・総当たり（SE Critical群） | §5.1/§5.4/§5.3 |
| G17 | **資格情報ライフサイクル**（Cookie属性＋CSRF／鍵ローテ／固定化対策／PHC string＋透過再ハッシュ／トークン生成・平文隔離／history追記専用） | CSRF・セッション固定・argon2移行不能・ハッシュパラメータ未確定（SE-D/C系） | §4.2a/§4.2b/§4.8/§4.9/§7 |
| G18 | **API契約**（統一エラーcode／`/v1/`＋互換規約／同期API戻り値／Observation Zod＋observed schema_version＋長さ契約／Idempotency-Key・If-Match・DELETE=archive固定・カーソルページング・PATCHセマンティクス／origin正規化・epoch ms・`{items}`統一） | 409二義性・サイレント破棄・実装着手不可（⑤Critical群） | §5.1/§5.5 |

**即値修正（事実確定・Grill不要）:**
- **D1-2:** レートリミットを公式 Workers Rate Limiting binding（2025-09 GA）採用に変更（旧「イソレート集中」前提は事実誤認のため撤回）。§5.3/§8.4。
- **D1-5:** `UPDATE … LIMIT` は D1サポート済（懸念は杞憂）。冪等WHERE前提＋移植互換テストを明記。§5.2/§8.1。
- **D1-8:** Smart Placement はランタイム設定でアダプタ隠蔽対象外と再分類。§3.2/§8.4。
- **D1-1/D1-3/D1-4/D1-6/D1-7:** chunk上限の文数換算・パージのDELETE…LIMITバッチ・shard単位（project/時間レンジ別）再定義・セッション読みレプリカ＆last_used_at間引き・行2MB/128MBメモリのZodサイズ検証。§5.2/§8.3a/§4.2b/§4.6/§4.8。

**残課題（浅い枝・後続反映可）:** DM-M6（1 external_ref→複数canonical分割の契約）、external_ref エイリアス/リマップAPI（DM-H4：同一origin内ref移行救済）、mirror_origin の自動委譲詳細（DM-H2）。いずれもハブ根幹を揺るがさないため、サテライト実装と並行して個別に確定する。
