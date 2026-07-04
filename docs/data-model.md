# TMS データモデル リファレンス

TMS Web Service の全エンティティ定義・関係・状態機械・設計上の不変条件を記述する。

関連ドキュメント:
- [architecture.md](./architecture.md) — レイヤ構成・ポータビリティ境界
- [api-reference.md](./api-reference.md) — REST API仕様（各エンティティの公開インターフェース）
- [sync-protocol.md](./sync-protocol.md) — 衛星同期プロトコル（データ書き込みフロー）
- [auth-security.md](./auth-security.md) — 認証・認可・テナント境界

---

## エンティティ関係図

```
Organization 1──N Project 1──N TestCase 1──N TestCaseObservation
        │           │                  ├────1──N TestCaseIdentity (origin別・マルチホーミング)
        │           │                  └────1──N TestCaseHistory
        │           ├──N ApiToken (プロジェクト単位スコープ)
        │           └──N SyncSession 1──N SyncStaging (commit作業領域)
        └──N User 1──N Session (UIログイン)
```

MVPでは Organization を単一固定（1行seed）で運用するが、テナント境界はデータアクセス層に最初から通す。

---

## Organization（テナント境界）

MVPは固定の単一orgをseedして運用。マルチテナント化時にretrofit不要な設計。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| name | TEXT | 組織名 |
| created_at | INTEGER (epoch ms) | 作成時刻 |
| updated_at | INTEGER (epoch ms) | 更新時刻 |

---

## User（UIユーザ）

テナント境界と同じ「retrofit地獄回避」の方針で、MVPでもユーザ実体を第一級で持つ。承認・編集の権威を「誰か」に帰属させ、監査を成立させる。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| organization_id | TEXT (FK → Organization) | orgスコープ |
| email | TEXT | ログインID。org内一意 |
| password_hash | TEXT? | PHC string形式。外部IdP時はnull可 |
| display_name | TEXT | 表示名 |
| role | TEXT enum | `admin` / `editor` / `viewer`。CHECK制約 |
| last_login_at | INTEGER? (epoch ms) | 最終ログイン成功時刻。ログイン成功のたびに更新（スペック D-05） |
| created_at | INTEGER (epoch ms) | 作成時刻 |
| updated_at | INTEGER (epoch ms) | 更新時刻 |

### パスワードハッシュ仕様

- **形式:** PHC string（アルゴリズム識別子＋パラメータ＋per-userソルト＋ハッシュを内包）
  - 例: `$pbkdf2-sha256$i=600000$<salt>$<hash>`
- **MVP既定:** WebCrypto PBKDF2-SHA256・イテレーション600,000（OWASP 2023基準）・16バイトCSPRNGソルト
- **検証:** プレフィックスでアルゴリズムdispatch
- **移行:** ログイン成功時に旧→新形式へ透過再ハッシュ（オンプレargon2へ無停止移行可）
- **隔離:** `Auth` インターフェース裏に閉じ込める

### ロール定義

| ロール | 権限 |
|---|---|
| admin | 全操作 + ユーザー管理 + トークン管理 + プロジェクト作成 |
| editor | テストケース作成・編集・ステータス変更・アーカイブ |
| viewer | 読み取りのみ |

---

## Session（UIセッションストア）

KV依存を避けD1/SQLite上で共通管理（ポータビリティ維持）。Cookieには署名付きセッションIDのみ。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT | PK。Cookieに載る署名付きセッションID。ログイン成功時に必ず再発行（セッション固定攻撃対策） |
| user_id | TEXT (FK → User) | ログインユーザ |
| expires_at | INTEGER | 失効時刻。認証ミドルウェアが毎リクエスト `expires_at > now` を検証 |
| created_at | INTEGER (epoch ms) | 発行時刻 |

### セッション管理の不変条件

- **Cookie属性:** `HttpOnly; Secure; SameSite=Lax; Path=/`
- **署名鍵:** Secret管理（CF Secret／オンプレはsecret manager）。鍵IDをプレフィックスで埋め、無停止ローテーション対応
- **検証:** 「署名検証 → DB存在 → 未失効」の三段AND
- **無効化:** パスワード変更／role変更時は当該userの全セッションを `DELETE FROM Session WHERE user_id=?` で無効化
- **CSRF:** SameSite=Lax を一次防御に、状態変更メソッド（POST/PATCH/DELETE）にdouble-submit CSRFトークン必須
- **読みスケール:** クラウドはD1 read replication（Sessions API）の採用を運用要件とする

---

## Project

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| organization_id | TEXT (FK → Organization) | 所属org。必須。全クエリはorgで絞る |
| name | TEXT | プロジェクト名 |
| repo_url | TEXT? | 連携元リポジトリ（任意） |
| created_at | INTEGER (epoch ms) | 作成時刻 |
| updated_at | INTEGER (epoch ms) | 更新時刻 |

---

## TestCase（★コアエンティティ）

canonical＝人間の正・全衛星サービスの契約コア。canonical変異の書き込みはcommit時のみ（chunkはTestCaseObservationへの追記専用）。

### 列の二分

TestCaseの列は明確に二分される：

**人間所有列**（commit由来の書き込み不可侵・OCC `version` 管理対象）：
- `title`, `target`, `category`, `given`, `when`, `then`, `parameters`, `status`, `confidence`, `metadata`
- `status` は完全に人間所有（システムがstatusを書く正当パスは存在しない）

**システム可変列**（commitの集合文が書く・`version` をbumpしない）：
- `is_stale`, `drift`, `fingerprint`, `mirror_origin`, `system_updated_at`

**遷移専用列：**
- `ownership` — `machine→human` は人間の初編集PATCHと同一文・同一トランザクションで `version` を+1して遷移

### テーブル定義

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK。安定ID |
| project_id | TEXT (FK → Project) | 所属プロジェクト |
| title | TEXT | テストケース名（人間可読） |
| target | TEXT? | 対象（例: `com.example.PaymentService#charge`） |
| category | TEXT enum | `normal` / `abnormal` / `boundary` / `error_handling`。CHECK制約 |
| given | TEXT | 事前条件（Given）。人間向けナレーション |
| when | TEXT | 操作（When） |
| then | TEXT | 期待結果（Then） |
| parameters | JSON? | データ駆動テスト用 `[{name?, inputs, expected}, ...]`。Zodで型定義 |
| status | TEXT enum | `draft` / `approved` / `archived`（3値）。CHECK制約＋Zod二重防御 |
| is_stale | INTEGER (bool) | canonical集約の派生キャッシュ。真実の源はTestCaseIdentity.is_stale |
| ownership | TEXT enum | `machine` / `human`。CHECK制約 |
| mirror_origin | TEXT? | ミラー権威オリジン。machine-owned中にcanonicalへ内容ミラーできるのはこのオリジンのみ |
| drift | INTEGER (bool) | `ownership=human` かつ非archived時のみ立てる。`fingerprint=null`は未評価=false |
| fingerprint | TEXT? | canonical確定時点のbehavioral-fingerprint。衛星供給・opaque |
| version | INTEGER | OCC用。人間所有列の更新時のみ+1 |
| confidence | REAL? | 抽出時の信頼度（衛星が付与、任意） |
| source_ref | JSON? | 出所参照（file/line/commit等） |
| created_origin | TEXT enum | 作成元の記録（`manual` / `discovery` / …）。provenance表示用 |
| metadata | JSON? | 柔軟メタデータ（タグ等） |
| human_updated_at | INTEGER? (epoch ms) | 人間編集時刻。未編集（machine-owned のまま等）はnull |
| system_updated_at | INTEGER? (epoch ms) | システム書き込み時刻。システムによる書き込みが未発生ならnull |
| created_at | INTEGER (epoch ms) | 作成時刻 |

### 複合不変条件

- `status IN ('approved','archived') ⇒ ownership='human'` — テーブルCHECKで表明
- `approved+machine` / `archived+machine` は到達不能（バグ落下を構造防止）

### ミラー昇格

machine-owned期間中の観測→canonicalへのミラーは、以下のガード付き相関UPDATE単一文で実行：

```sql
WHERE ownership='machine' AND status NOT IN ('archived') AND mirror_origin=:O
```

D1単一ライタがimport↔人間編集の競合を原子的に相互排他する。

### OCC（楽観的排他制御）

- PATCHは `version` 一致を要求（`If-Match` ヘッダ）
- 不一致時は409 `OCC_CONFLICT`
- importのシステム可変列更新はversionをbumpしない（背景sync中の理不尽な409を防ぐ）

---

## TestCaseIdentity（マルチホーミング・同定）

1つのcanonicalに対し、複数のオリジンがそれぞれの `external_ref` で同時に紐づける。per-originの同期台帳。**stalenessの真実の源はここ**。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| test_case_id | TEXT (FK → TestCase) | 紐づくcanonical |
| project_id | TEXT (FK → Project) | スコープ用 |
| origin | TEXT | このidentityのオリジン（衛星） |
| external_ref | TEXT | 当該オリジンの参照ID（opaque・長さ≤512・printable ASCII） |
| is_stale | INTEGER (bool) | per-origin stalenessの真実の源 |
| last_seen_sync_token | TEXT? | 直近committed syncでの出現トークン |
| last_seen_at | INTEGER? | 直近出現確認時刻。集約rollupのlive判定（TTL=90日既定）に使用 |
| created_at | INTEGER (epoch ms) | 紐付け時刻 |

### 一意制約

- `(project_id, origin, external_ref)` — 冪等同定

### staleness集約ルール

canonical.is_stale は以下の派生キャッシュ：
1. `last_seen_at > now - TTL`（既定90日）の **liveなidentityのみ** を集約対象とする
2. TTL超の凍結identityは集約から除外（二度とsyncしてこない引退オリジンの永久ブロッカーを防ぐ）
3. 「TTL以内のlive identityがすべてstale」のとき canonical.is_stale = true
4. rollupのWHEREで `status NOT IN ('approved','archived')` を保護

### commitでの更新フロー

- 当該originの今回sessionで未出現（`last_seen_sync_token != :T`）→ `is_stale=true`
- 再出現 → `is_stale=false`
- 各originのcommitは自分のidentity行のみを触る（origin間で完全独立・無競合）

---

## TestCaseObservation（衛星の観測時系列）

chunkの唯一の書き込み先。直前観測と指紋が異なる時だけ行を作成（変化点のみ記録）。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| test_case_id | TEXT (FK → TestCase?) | 対応するcanonical。新規ケースはcommitで確定・backfill |
| external_ref | TEXT | 観測元の参照ID（commit前の同定キー） |
| project_id | TEXT (FK → Project) | スコープ用 |
| fingerprint | TEXT | この観測のbehavioral-fingerprint（衛星供給・opaque・長さ≤512） |
| observed | JSON | 観測スナップショット。固定キーセット（下記参照） |
| sync_token | TEXT | この観測を記録したセッショントークン |
| origin | TEXT | 観測元の衛星 |
| confidence | REAL? | 抽出信頼度（0.0〜1.0、任意）。observedの固定キーセットとは別に観測1件のトップレベル属性として保持 |
| category | TEXT? | 観測1件のトップレベル任意カテゴリ（`normal` / `abnormal` / `boundary` / `error_handling`）。未指定はcommit時に`normal`既定を適用。CHECK制約は付けずZodのみで検証（単一書込経路のため二重防御を省略） |
| created_at | INTEGER (epoch ms) | 観測時刻 |

### observed の固定キーセット

```json
{
  "title": "...",
  "given": "...",
  "when": "...",
  "then": "...",
  "parameters": [...],
  "source_ref": {...},
  "schema_version": "..."
}
```

`schema_version` で構造化Diffのバージョン跨ぎを区別する。バイトサイズはZodで上限検証（D1の行2MB上限を割らない）。

### 冪等性の一意制約

```
(external_ref, origin, sync_token, fingerprint)
```

chunkは `INSERT … ON CONFLICT DO NOTHING` で実行。同一chunkのネットワーク再送・並行二重処理が観測を二重INSERTしないことをDBが保証。

### 変化点の比較基準

`(test_case_id|external_ref, origin)` 単位で比較する。per-canonical比較だとマルチホーミングでorigin間が交互に変化点判定され観測爆発するため、必ずorigin単位。

### パージポリシー

- **時間基準:** committed観測は90日保持（既定）。件数基準Nは実測後に決定
- **不変条件:** 各 `(test_case_id, origin)` につき直近のcommitted観測を最低1件は期間に関わらず必ず残す（drift/構造化Diffの足場保護）
- **フィルタ:** 削除・残置の両述語に `status='committed'` フィルタ（observation→SyncSession join）を強制
- **実行:** `DELETE … LIMIT` の小バッチ反復で30秒/行数上限を回避

### 意味論的隔離

drift/stale判定・構造化Diffが参照する `latest(observation)` は `SyncSession.status='committed' OR token=:T` 由来の観測のみを対象とする。active/expiredセッション由来の観測は物理的に残っても意味論的に無視。

---

## SyncSession（同期セッション）

衛星サービスとの同期を管理するセッション。詳細なプロトコルは [sync-protocol.md](./sync-protocol.md) を参照。

| 列 | 型 | 説明 |
|---|---|---|
| token | TEXT | PK。`start`で発行 |
| project_id | TEXT (FK → Project) | 対象プロジェクト |
| origin | TEXT | 対象origin |
| status | TEXT enum | `active` / `committed` / `expired`。CHECK制約 |
| started_at | INTEGER | 発行時刻 |
| expires_at | INTEGER | 失効時刻 |
| committed_at | INTEGER? | commit完了時刻（スペック D-01）。工程8（セッション確定）と同一バッチで書く |
| created_count | INTEGER? | 集計列（D-01）。当該tokenのSyncStaging行数（新規canonical数） |
| changed_count | INTEGER? | 集計列（D-01）。当該tokenのTestCaseObservationのDISTINCT external_ref数（変化点が記録されたケース数） |
| staled_count | INTEGER? | 集計列（D-01）。当該(project,origin)で`last_seen_sync_token != token`のidentity数 |

いずれも全て既存テーブルから再計算可能な純関数であり、mid-commit再開でも冪等（[sync-protocol.md「Commit 8工程パイプライン」工程8](./sync-protocol.md#工程-8-セッション確定)参照）。`GET /api/v1/projects/:pid/sync/status`（スペック D-01。[api-reference.md](./api-reference.md)のエンドポイント一覧参照）がorigin別の最新committedセッションからこれらの値を返す。

### 一意性のDB委譲

同一 `(project_id, origin)` の能動セッションは1つに限定。部分一意索引で強制：

```sql
CREATE UNIQUE INDEX uq_active_session
  ON SyncSession(project_id, origin)
  WHERE status='active';
```

`start` は `batch([期限切れactive→expired UPDATE, 新active INSERT])` を1バッチで実行。競合した2人目のINSERTは一意制約違反→409。

### スライディング失効

chunk/commitの各リクエストで `expires_at` を「最終アクティビティ+10分」へ延長。正当に長い大規模commitが進行中の間は並走startに失効回収されず、衛星突然死時は最大10分でロック自動解放。

### 失効の執行モデル

- **プライマリ:** 遅延評価。`start`/`chunk`/`commit`の各エントリで `now > expires_at` のactiveセッションをその場で `expired` に倒す
- **セカンダリ:** Cron sweep（表示整合・掃除。正しさは遅延評価が保証）

### mid-commitクラッシュの回復

新startではなく「同一tokenでのcommit再開」。全工程を冪等に設計しているため、同じtokenの再送で続きから収束する。

---

## SyncStaging（commit作業領域）

commit冒頭で「新規 `external_ref` → 新規 `test_case_id`（uuid）」を集合INSERTする一時表。identity↔canonicalの循環生成（FK順序）を断つ。

| 列 | 型 | 説明 |
|---|---|---|
| sync_token | TEXT (FK → SyncSession) | 対象セッション |
| external_ref | TEXT | 新規ケースの参照ID |
| new_test_case_id | TEXT (uuid) | 採番したcanonical PK |

### 設計上の役割

- id採番が永続化されクラッシュ再開で同一idに収束
- commitレスポンスの `external_ref → test_case_id` マップにも再利用
- `ON CONFLICT(sync_token, external_ref) DO NOTHING` で冪等
- セッション寿命のみの一時データ。確定/失効後にパージ対象

---

## SyncSeen（出現台帳・実装専用）

chunkは変化点のみ観測を記録するため（TestCaseObservationへは指紋が変化したrefしか行が作られない）、commit工程3（last_seen確定＋un-stale）／工程4（staleマーク）が「今回セッションで出現したref」を判定する参照先として、TestCaseObservationとは別に導入した実装専用テーブル。観測ではなくこちらを参照することで、変化なしrefを誤ってstale判定することを防ぐ。

| 列 | 型 | 説明 |
|---|---|---|
| sync_token | TEXT (FK → SyncSession) | 対象セッション |
| external_ref | TEXT | 受信した参照ID（変化点の有無に関わらず、chunkで受信した全refが対象） |

### 設計上の役割

- chunk受信時に、受信した全ref（変化点の有無を問わない）を `(sync_token, external_ref)` の一意制約でON CONFLICT DO NOTHINGしながらINSERTする
- commit工程3／工程4はTestCaseObservationではなくSyncSeenを参照する（[sync-protocol.md](./sync-protocol.md#工程-3-last_seen-確定再出現un-stale)参照）
- PKを持たず一意索引 `(sync_token, external_ref)` のみで冪等性を担保する（SyncStagingと同じ設計）
- セッション寿命のみの一時データ。確定/失効後にパージ対象（`Storage.purgeSyncWorkdata` がSyncStagingと合わせて削除する）
- 本ドキュメント・sync-protocol.mdのいずれにも元々記載がなかった実装専用テーブル（`src/storage/schema.ts` のコメントが正）。`countsSnapshot`（運用監視ログ）の対象11エンティティにも含めない

---

## ApiToken（衛星向け認証）

衛星サービスがTMS APIを呼ぶためのトークン。プロジェクト単位スコープで最小権限を実現。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT (uuid) | PK |
| project_id | TEXT (FK → Project) | スコープ対象プロジェクト |
| token_hash | TEXT | トークンの決定的SHA-256（saltなし・索引付き） |
| name | TEXT | 用途ラベル（どの衛星か） |
| last_used_at | INTEGER? | 直近利用時刻。best-effort・非ブロッキング・間引き更新（閾値1分） |
| created_at | INTEGER | 発行時刻 |
| revoked_at | INTEGER? | 失効時刻 |

### トークン生成仕様

- `crypto.getRandomValues` で32バイト以上
- base64url エンコード
- 識別プレフィックス付き（例: `tms_…`）
- Zodで長さ下限を検証（「高エントロピー前提」を契約化）

### 認証照合

高エントロピートークン前提で、Bearer受信時にSHA-256ハッシュの完全一致で直接シーク（O(1)）。平文は保存しない。

### 失効の執行

認証述語に内包：`SELECT … WHERE token_hash=? AND revoked_at IS NULL`。ヒットしなければ401。「記録列」ではなく「執行点」として機能。

### ライフサイクル

- 発行/一覧/失効APIは `role=admin` 限定
- 発行時の応答bodyで平文トークンを1回だけ返す（以後は二度と取得不可）
- 失効は `revoked_at` を打つソフト失効
- 平文はログ・履歴・監査・エラーボディに一切含めない（記録は `token:<id>` のみ）

---

## TestCaseHistory（変更履歴）

人間の編集ログ。追記専用（UPDATE/DELETE禁止）。

| 列 | 型 | 説明 |
|---|---|---|
| id | TEXT | PK |
| test_case_id | TEXT (FK → TestCase) | 対象 |
| actor | TEXT | 実行者の型付き参照（`user:<id>` / `token:<id>`） |
| action | TEXT enum | `created` / `updated` / `status_changed` / `imported`。CHECK制約 |
| delta | JSON | 変更フィールドのみの差分 `{field: {before, after}}` |
| created_at | INTEGER (epoch ms) | 発生時刻 |

### 不変条件

- UPDATE/DELETE禁止の追記専用（Append-only）。ドメイン層・DB制約の両面で不変オブジェクト化
- パージは保持ポリシーに基づく古い行の一括削除のみ（改竄ではない）
- tokenのactorのactionは `imported` に限定（sync経路のみ＝自然成立）
- デルタ保存（フルスナップショットではない）で容量・I/Oを最適化

---

## canonical 状態機械

TestCaseは `status`（3値）と `ownership`（2値）の二軸＋直交フラグ `is_stale` / `drift` で状態を管理する。

### 状態遷移図

```
[新規 import]
   └─▶ draft / machine-owned        … mirror_originの最新観測をcanonicalにミラー
         │  人間が編集 or 承認（最初の接触）
         ▼  ownership: machine ─不可逆─▶ human
   draft / human-owned
         │  レビュー・承認
         ▼
   approved / human-owned            … 以後importはcanonicalの人間所有列を上書きしない
         │                               観測との指紋差は drift=true として記録のみ
         │  再レビューが必要（人間の明示操作）
         ├─▶ draft / human-owned     … approved → draft 差し戻し
         │
         │  sync commitで当該originに未出現（他オリジンも未観測）
         ▼
   is_stale = true（直交・非破壊マーク）… approvedはis_stale化しない。statusは不変
         │  後続syncで external_ref 再出現
         ├─▶ is_stale = false（statusは元から不変なので「復帰」処理は不要）
         │  人間が確認
         ▼
   archived（人間の明示操作・ソフトデリート＝ミラー停止境界）
         │  不要判断を覆す（人間の明示操作）
         └─▶ draft / human-owned     … archived → draft 復帰（再レビュー対象）
```

### status（3値）

| 値 | 意味 |
|---|---|
| draft | 下書き。新規importはここから開始。approved/archivedからの復帰先 |
| approved | 承認済み。is_stale化しない（承認意思の保護）。人間の明示操作でdraftに差し戻し可 |
| archived | アーカイブ。ソフトデリート。ミラー停止の絶対境界。人間の明示操作でdraftに復帰可 |

### 状態遷移の許可マトリクス

| 遷移 | 許可 | 条件 | 操作者 |
|---|---|---|---|
| draft → approved | ○ | — | editor以上 |
| draft → archived | ○ | — | editor以上 |
| approved → draft | ○ | 再レビューが必要な場合 | editor以上 |
| approved → archived | ○ | — | editor以上 |
| archived → draft | ○ | アーカイブからの復帰 | editor以上 |
| archived → approved | ✕ | 復帰は必ずdraftを経由する | — |

**制約:**
- approved/archived からの復帰は必ず draft を経由する（直接 archived → approved は不可）
- 復帰操作は TestCaseHistory に `status_changed` として記録される
- 復帰後もownershipはhumanのまま（machineに戻すにはre-adopt操作が必要 `[※MVP後]`）

### ownership（2値）

| 値 | 意味 |
|---|---|
| machine | 衛星が管理中。mirror_originの観測でcanonical内容を更新可能 |
| human | 人間が所有。import不可侵。観測差はdriftとして記録のみ |

- `machine→human` は不可逆。人間の最初の「値が実際に変化した人間所有列のPATCH」で遷移
- 同値PATCH（no-op）では遷移しない
- admin による re-adopt（machine への再採用）操作で誤操作を救済可能 `[※MVP後]`
- re-adopt は admin 専用の救済操作。human → machine への逆遷移を許可する。usecase.md 上は明示的なフローとして定義されていないが、誤って human 化したテストケースを Discovery の自動管理下に戻すための非常手段として提供する `[※MVP後]`（MVP構築スペック「対象外」区分・D-12。本MVPには実装しない）

### drift

- `ownership=human` かつ 非archived時のみ立てる（machine/archivedには記録しない）
- 基準: `mirror_origin` の最新committed観測指紋 ≠ canonical.fingerprint
- `fingerprint=null`（手動作成）は未評価＝false
- accept-fingerprint操作（最新committed観測の指紋をOCC下で採用）で解消

### is_stale

- 真実の源はTestCaseIdentity.is_stale（per-origin）
- canonical.is_staleはrollup集約の派生キャッシュ
- `status NOT IN ('approved','archived')` は is_stale=true にしない（保護）

### archived の再観測

- archived canonicalが再syncで現れても observation記録のみ行い、canonical内容・status・is_staleは不変
- identityはarchive後も保持（再syncでのゾンビ化を防ぐ）
- アーカイブからの復帰は人間の明示操作のみ

---

## 設計上のポイント

### インデックス設計

| 対象 | インデックス | 用途 |
|---|---|---|
| TestCase | `(project_id, status)` | ステータスフィルタ |
| TestCase | `(project_id, category)` | カテゴリフィルタ |
| TestCase | `(project_id, is_stale)` | staleバッジ抽出 |
| TestCase | `(project_id, drift)` | driftバッジ抽出 |
| ApiToken | `(token_hash)` | O(1)認証照合 |
| TestCaseIdentity | `(project_id, origin, external_ref)` UNIQUE | 冪等同定 |
| TestCaseIdentity | `(project_id, origin, last_seen_sync_token)` | stale判定 |
| TestCaseIdentity | `(test_case_id, is_stale, last_seen_at)` | canonical rollup集約 |
| TestCaseObservation | `(test_case_id, created_at)` | 時系列取得 |
| TestCaseObservation | `(project_id, sync_token)` | セッション単位取得 |
| TestCaseObservation | `(external_ref, origin, sync_token, fingerprint)` UNIQUE | 冪等INSERT |
| SyncSession | `(project_id, origin) WHERE status='active'` PARTIAL UNIQUE | 一意性DB委譲 |
| SyncSession | `(project_id, status, committed_at)` | `GET /sync/status`（D-01）のorigin別最新committedセッション取得 |

### enum の二重防御

SQLiteにenum型は無いため：
- **安定列**（status/category/ownership/role/action）→ CHECK制約＋Zod で二重に縛る
- **流動列**（origin・メタ分類）→ CHECKを外しZodのみとし、ALTER頻度を抑える

### Given/When/Then の位置づけ

- 人間向けナレーション（ビュー）であり、同一性・drift判定には使わない
- 同一性・挙動変化の判定は behavioral-fingerprint（衛星供給・opaque）で行う
- Gherkin/自然言語ビューは given/when/then + parameters から派生描画

### 同一性は衛星責任・TMSは契約

- `external_ref`（同一ケース判定）も `fingerprint`（挙動変化判定）も、TMSはopaqueに扱う
- 安定性の責任は衛星に課す
- TMSは普通のCRUD＋境界制御に徹し、AI由来の不確実性をハブから締め出す

### テナント境界

- `Storage` インターフェースの全メソッドが orgScope を要求するシグネチャ
- 全クエリをorgで絞り、越境をコンパイル時に防止
- APIトークンはprojectスコープ、`:pid` のorg不一致は403

### JSON列のフィルタ最適化

`metadata`/`parameters` を高頻度フィルタ条件にする場合、対象プロパティ（例 `tags`）をSQLite Generated Column（STORED/VIRTUAL）に切り出し索引を張る（D1ネイティブ・Drizzleで定義）。

### Zodスキーマを単一の真実の源

Zodスキーマを正本とし、API入力検証・DBモデル・型を一元化（Drizzleと連携）。SQLite方言に閉じることで、D1⇔libSQL⇔better-sqlite3でスキーマ・SQLを共通化。
