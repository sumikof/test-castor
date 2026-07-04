# 衛星同期プロトコル

## このドキュメントについて

TMS Web Service（ハブ）と衛星サービス（Discovery等）間のテストケース取り込みプロトコルの仕様書。衛星サービスの実装者が本ドキュメントのみで同期クライアントを構築できることを目標とする。

**関連ドキュメント:**
- [データモデル](data-model.md) — エンティティ定義・状態機械
- [API リファレンス](api-reference.md) — 共通仕様（エラースキーマ・ページング・OCC等）
- [認証・セキュリティ](auth-security.md) — APIトークン認証

---

## 設計原則

### なぜ同期セッション方式か

単発 Upsert ではソース側で削除されたテストケースが TMS に残り続ける（オーファン化）。同期セッション方式は「今回の同期で現れなかったケース」を検知し、stale マークを付与することでオーファンを非破壊的に管理する。

### 最上位方針

> **chunk は観測の追記専用。canonical 変異・同定・ミラー・stale はすべて commit 時の述語駆動集合文に集約する。**

この分離により：
- commit されるまで正（canonical）に触れない = 未確定データによる汚染を構造排除
- chunk の途中失敗は「観測が足りないだけ」で矛盾状態を生まない
- commit は全工程が冪等 = クラッシュ後に同一トークンで再開すれば収束する

---

## プロトコルフロー

```
衛星サービス                          TMS Hub
    │                                    │
    │  POST /sync/start {origin}         │
    │───────────────────────────────────▶│
    │  { sync_token, expires_at, ... }   │
    │◀───────────────────────────────────│
    │                                    │
    │  POST /sync/:token/chunk           │
    │  [observations batch 1]            │
    │───────────────────────────────────▶│  → TestCaseObservation に追記
    │  { accepted, received }            │
    │◀───────────────────────────────────│
    │                                    │
    │  POST /sync/:token/chunk           │
    │  [observations batch 2]            │
    │───────────────────────────────────▶│  → TestCaseObservation に追記
    │  { accepted, received }            │
    │◀───────────────────────────────────│
    │            ...                     │
    │                                    │
    │  POST /sync/:token/commit          │
    │───────────────────────────────────▶│  → 8工程パイプライン実行
    │  { status, mappings, more }        │
    │◀───────────────────────────────────│
    │                                    │
    │  (more=true の場合、再度 commit)    │
    │  POST /sync/:token/commit          │
    │───────────────────────────────────▶│  → 続きから再開
    │  { status, mappings, more:false }  │
    │◀───────────────────────────────────│
```

---

## エンドポイント詳細

### POST `/api/v1/projects/:pid/sync/start`

同期セッションを開始する。

**認証:** Bearer トークン（プロジェクトスコープ）

**リクエスト:**

```json
{
  "origin": "discovery-v1"
}
```

**レスポンス（201 Created）:**

```json
{
  "sync_token": "syn_abc123...",
  "expires_at": 1719561600000,
  "server_time": 1719558000000,
  "max_chunk_size": 500
}
```

**制約:**

- 同一 `(project_id, origin)` につき、能動セッション（status=active）は1つのみ
- DB レベルの部分一意索引で強制:
  ```sql
  CREATE UNIQUE INDEX uq_active_session
    ON SyncSession(project_id, origin)
    WHERE status = 'active';
  ```
- 実装は `batch([期限切れactiveをexpiredに倒すUPDATE, 新active INSERT])` を1トランザクションで実行
- 2人目の INSERT が一意制約に衝突 → **409 `DUPLICATE_SYNC_SESSION`**

**`origin` の規則:**
- 小文字・英数字・ハイフン・アンダースコアのみ
- 既知プレフィックス推奨（例: `discovery-`, `selfheal-`）
- mirror 権威判定・stale 判定は完全一致に依存するため、正規化を厳守すること

---

### POST `/api/v1/projects/:pid/sync/:token/chunk`

観測データを送信する。**TestCaseObservation への追記のみ**を行い、canonical/identity/stale には一切触れない。

**認証:** Bearer トークン（プロジェクトスコープ）

**リクエスト:**

```json
{
  "observations": [
    {
      "external_ref": "com.example.PaymentServiceTest#testCharge_success",
      "fingerprint": "sha256:a1b2c3d4...",
      "observed": {
        "title": "正常なクレジットカードで決済が成功する",
        "given": "有効なクレジットカードが登録済み",
        "when": "charge(1000) を呼び出す",
        "then": "決済成功レスポンスが返る",
        "parameters": [
          {"name": "amount_100", "inputs": {"amount": 100}, "expected": {"status": "success"}},
          {"name": "amount_max", "inputs": {"amount": 999999}, "expected": {"status": "success"}}
        ],
        "source_ref": {"file": "src/test/PaymentServiceTest.java", "line": 42, "commit": "abc123"},
        "schema_version": "1.0"
      },
      "confidence": 0.95,
      "source_ref": {"file": "src/test/PaymentServiceTest.java", "line": 42},
      "category": "normal"
    }
  ]
}
```

**レスポンス（200 OK）:**

```json
{
  "accepted": 1,
  "received": [
    {"external_ref": "com.example.PaymentServiceTest#testCharge_success", "outcome": "inserted"}
  ]
}
```

`outcome` の値:
- `inserted` — 新しい変化点として記録
- `duplicate` — 同一指紋の観測が既存のため記録省略（冪等）

**観測データの仕様:**

| フィールド | 必須 | 説明 |
|---|---|---|
| `external_ref` | Yes | 衛星が付与する安定な参照ID。≤512文字・printable ASCII |
| `fingerprint` | Yes | 挙動の指紋（opaque）。≤512文字・printable ASCII |
| `observed` | Yes | 観測スナップショット（固定キーセット） |
| `confidence` | No | 抽出信頼度（0.0〜1.0） |
| `source_ref` | No | ソースコード参照 |
| `category` | No | `normal` / `abnormal` / `boundary` / `error_handling`。観測1件のトップレベル任意カテゴリ（`observed` 固定キーセットとは別）。未指定時はcommit時にcanonical生成側が既定値 `normal` を適用する |

**`observed` の固定キーセット:**

| キー | 説明 |
|---|---|
| `title` | テストケース名（人間可読な意図の要約） |
| `given` | 事前条件 |
| `when` | 操作 |
| `then` | 期待結果 |
| `parameters` | パラメータ化テスト用データセット `[{name?, inputs, expected}]` |
| `source_ref` | ソース参照 |
| `schema_version` | 観測スキーマのバージョン（構造化Diffのバージョン跨ぎ判別用） |

**変化点のみ記録:**

同一 `(external_ref, origin)` について、直前の観測と `fingerprint` が異なる場合のみ新しい行を作成する。同一指紋の再送は `ON CONFLICT DO NOTHING` で吸収される。

**冪等性の保証:**

一意制約 `(external_ref, origin, sync_token, fingerprint)` により、ネットワーク再送・並行二重処理でも観測は重複しない。

**D1 制約への対応:**
- 1 INSERT 文あたり ≤16 行（D1 の bind パラメータ上限）
- 1 chunk リクエストあたり ≤500 観測（`max_chunk_size` で通知）
- 観測全体のバイトサイズは Zod で上限検証（D1 行サイズ 2MB 上限）

**スライディング失効:**

chunk リクエストを受けるたびに `expires_at` を「現在時刻 + 10分」に延長する。正当に長い大量送信中にセッションが失効することを防ぐ。

---

### POST `/api/v1/projects/:pid/sync/:token/commit`

同期セッションを確定し、canonical への反映を実行する。冪等に再開可能。

**認証:** Bearer トークン（プロジェクトスコープ）

**リクエスト:** ボディなし

**レスポンス（200 OK / 202 Accepted）:**

```json
{
  "status": "completed",
  "staled_count": 3,
  "more": false,
  "mappings": [
    {"external_ref": "com.example.PaymentServiceTest#testCharge_success", "test_case_id": "uuid-1234", "outcome": "created"},
    {"external_ref": "com.example.PaymentServiceTest#testRefund", "test_case_id": "uuid-5678", "outcome": "updated"}
  ]
}
```

- **200**: 全工程完了（`more: false`）
- **202**: 部分完了（`more: true`）— 同一トークンで再度 commit を呼ぶ

`mappings` 各要素の `outcome` の値:
- `created` — 新規 canonical を作成
- `updated` — ミラー昇格または drift 記録を実施
- `unchanged` — 変化なし

`staled`（今回セッションで未出現のため stale マーク）は `mappings` の `outcome` には含めない。stale化した件数はレスポンス直下の `staled_count` でのみ報告する（`mappings` は created/updated/unchanged の3値のみを取る）。

**大規模セットの分割実行:**

工程 3〜7 は `LIMIT` ウィンドウで分割される。`more: true` が返る間、同一トークンで再送すると続きから処理される。全工程が冪等設計のため、クラッシュ後の再送も安全に収束する。

---

### GET `/api/v1/projects/:pid/sync/status`

同期の要約状況を返す（S-08 テストケース一覧の「同期サマリーパネル」のバッキング API。commit のレスポンスは衛星にしか返らないため新設）。

**認証:** セッション Cookie または Bearer トークン（プロジェクトスコープ）。viewer 以上のロール。

**リクエスト:** ボディなし。

**レスポンス（200 OK）:**

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

| フィールド | 型 | 説明 |
|---|---|---|
| `origins[].origin` | string | 衛星識別子 |
| `origins[].last_committed_at` | integer (epoch ms) | 当該originの最新commit完了時刻 |
| `origins[].last_summary` | object | 当該originの最新commitが記録した `{created, changed, staled}`（SyncSessionの集計列をそのまま反映） |
| `current.unreviewed` | integer | `status=draft AND ownership=machine` の件数（非archived） |
| `current.drift` | integer | `drift=true` の件数（非archived） |
| `current.stale` | integer | `is_stale=true` の件数（非archived） |

- `origins` はorigin別の**最新committedセッションのみ**。committedセッションが一度も無いoriginは含めない
- S-08 パネルへの対応: 「新規 N 件」= `last_summary.created`、「drift / stale 件数」= `current`、「最終同期日時」= `last_committed_at`。`changed_count` はパネル必須ではない参考値（新規ケースも変化点として含むため）

---

## Commit 8工程パイプライン

対象セッション `(project_id=P, origin=O, sync_token=T)` について、すべて set-based・冪等に実行する。

### 工程 0: 同定採番（SyncStaging）

新規 `external_ref`（既存の canonical が無いもの）に対して UUID を採番し、SyncStaging テーブルに永続化する。

```sql
INSERT INTO SyncStaging (sync_token, external_ref, new_test_case_id)
SELECT :T, o.external_ref, uuid()
FROM TestCaseObservation o
WHERE o.sync_token = :T
  AND NOT EXISTS (
    SELECT 1 FROM TestCaseIdentity i
    WHERE i.project_id = :P AND i.origin = :O AND i.external_ref = o.external_ref
  )
GROUP BY o.external_ref
ON CONFLICT(sync_token, external_ref) DO NOTHING;
```

**冪等ガード:** `ON CONFLICT DO NOTHING` — クラッシュ再開時に同一 ID に収束する。

### 工程 1: Canonical 生成

Staging の新規 ID を使って TestCase レコードを作成する。

```sql
INSERT INTO TestCase (id, project_id, title, status, ownership, mirror_origin, ...)
SELECT s.new_test_case_id, :P, '', 'draft', 'machine', :O, ...
FROM SyncStaging s
WHERE s.sync_token = :T
  AND NOT EXISTS (SELECT 1 FROM TestCase tc WHERE tc.id = s.new_test_case_id);
```

**冪等ガード:** `NOT EXISTS` — 既に存在する canonical は skip。

### 工程 2: Identity 生成

新規ケースの同定レコード（TestCaseIdentity）を作成する。

```sql
INSERT INTO TestCaseIdentity (id, test_case_id, project_id, origin, external_ref, ...)
SELECT uuid(), s.new_test_case_id, :P, :O, s.external_ref, ...
FROM SyncStaging s
WHERE s.sync_token = :T
ON CONFLICT(project_id, origin, external_ref) DO NOTHING;
```

**冪等ガード:** `ON CONFLICT DO NOTHING`。

### 工程 3: last_seen 確定＋再出現（un-stale）

今回セッションで**出現があった**（chunkで受信した。変化点の有無を問わない）identity の `last_seen_sync_token` を更新し、stale を解除する。

```sql
UPDATE TestCaseIdentity
SET last_seen_sync_token = :T,
    last_seen_at = :now,
    is_stale = 0
WHERE project_id = :P
  AND origin = :O
  AND external_ref IN (
    SELECT DISTINCT s.external_ref
    FROM SyncSeen s
    WHERE s.sync_token = :T
  );
```

**実装注記（工程3・工程4共通）:** 参照元は TestCaseObservation ではなく [SyncSeen](./data-model.md#syncseen出現台帳実装専用)（出現台帳）。chunk は変化点のみ観測を記録するため（直前観測と指紋が同一の ref は観測行を作らない）、ここを TestCaseObservation で判定すると「変化が無かった ref」が今回「出現しなかった」ことになり、工程4が誤って stale マークしてしまう。SyncSeen は chunk が受信した全 ref（変化点の有無を問わない）を記録する出現台帳であり、これを参照することで「chunk は追記専用」「変化点のみ記録」「stale 判定の正確性」の3つを同時に満たす。

**冪等ガード:** `is_stale = 0` の再設定は冪等。

### 工程 4: Stale マーク（per-origin）

今回セッションで出現しなかった当該 origin の identity を stale にする。

```sql
UPDATE TestCaseIdentity
SET is_stale = 1
WHERE project_id = :P
  AND origin = :O
  AND last_seen_sync_token != :T;
```

**冪等ガード:** `is_stale = 1` の再設定は冪等。各 origin は自分の identity 行のみを触る = origin 間で完全独立・無競合。

### 工程 5: ミラー昇格

machine-owned かつ非 archived の canonical に対し、mirror_origin の最新観測を canonical にミラーする。

```sql
UPDATE TestCase
SET title = json_extract(obs.observed, '$.title'),
    given = json_extract(obs.observed, '$.given'),
    [when] = json_extract(obs.observed, '$.when'),
    [then] = json_extract(obs.observed, '$.then'),
    parameters = json_extract(obs.observed, '$.parameters'),
    fingerprint = obs.fingerprint,
    system_updated_at = :now
FROM (
  SELECT o.observed, o.fingerprint, i.test_case_id
  FROM TestCaseObservation o
  JOIN TestCaseIdentity i ON i.external_ref = o.external_ref AND i.origin = :O AND i.project_id = :P
  WHERE o.sync_token = :T
    -- 最新観測を選択するサブクエリ
) obs
WHERE TestCase.id = obs.test_case_id
  AND TestCase.ownership = 'machine'
  AND TestCase.status NOT IN ('archived')
  AND TestCase.mirror_origin = :O;
```

**冪等ガード:** WHERE 述語が自然に冪等。machine-owned でなくなった（人間が編集した）ケースは自動的にスキップされ、人間の編集とのロストアップデートを構造排除する。

### 工程 6: Drift 記録

human-owned の canonical について、最新 committed 観測の指紋と canonical の指紋を比較し、乖離があれば drift フラグを立てる。

```sql
UPDATE TestCase
SET drift = 1,
    system_updated_at = :now
WHERE project_id = :P
  AND ownership = 'human'
  AND status NOT IN ('archived')
  AND mirror_origin = :O
  AND fingerprint IS NOT NULL  -- 手動作成（fingerprint=null）は未評価
  AND fingerprint != (
    SELECT o.fingerprint
    FROM TestCaseObservation o
    JOIN TestCaseIdentity i ON i.external_ref = o.external_ref AND i.origin = :O AND i.project_id = :P
    JOIN SyncSession ss ON ss.token = o.sync_token AND (ss.status = 'committed' OR ss.token = :T)
    WHERE i.test_case_id = TestCase.id
    ORDER BY o.created_at DESC
    LIMIT 1
  );
```

**冪等ガード:** `drift = 1` の再設定は冪等。

### 工程 7: Canonical Rollup

全 identity の stale 状態を集約し、canonical の `is_stale` フラグを更新する。

```sql
UPDATE TestCase
SET is_stale = (
  NOT EXISTS (
    SELECT 1 FROM TestCaseIdentity i
    WHERE i.test_case_id = TestCase.id
      AND i.is_stale = 0
      AND i.last_seen_at > :now - :TTL  -- TTL内のlive identityのみ対象
  )
  AND EXISTS (
    SELECT 1 FROM TestCaseIdentity i
    WHERE i.test_case_id = TestCase.id
      AND i.last_seen_at > :now - :TTL  -- 凍結origin（TTL超）は集約から除外
  )
),
system_updated_at = :now
WHERE project_id = :P
  AND status NOT IN ('approved', 'archived');  -- approved/archivedは保護
```

**冪等ガード:** 純関数であり何度実行しても同一結果。

**TTL（既定90日）:** `last_seen_at` が TTL を超えた identity は凍結として集約から除外する。引退したオリジンが永久ブロッカーになることを防ぐ。

**保護対象:** `approved` と `archived` は rollup 対象外。人間の承認意思と削除意思を機械的に上書きしない。

### 工程 8: セッション確定

全工程が完了した後にセッションを committed に遷移する。

```sql
UPDATE SyncSession
SET status = 'committed'
WHERE token = :T AND status = 'active';
```

この文は必ず最後に実行する。committed 後は同一トークンでの chunk は受け付けない。

---

## 不変条件とエラーハンドリング

### セッションライフサイクル

```
start
  │
  ▼
active ──chunk/commit──▶ active（expires_at 延長）
  │                         │
  │ expires_at 超過          │ commit 全工程完了
  ▼                         ▼
expired                  committed
```

- `active` → `committed`: commit 全工程完了時のみ
- `active` → `expired`: `expires_at` 超過時（遅延評価で検知）
- 逆方向の遷移は存在しない

### 失効セッションの観測

expired/uncommitted セッションの観測は canonical に昇格しない。物理的に TestCaseObservation に残るが、意味論的に無視される（パージの優先回収対象）。

### committed-JOIN フェンス

drift/stale/Diff 判定が参照する「最新観測」は、以下の条件を満たすもののみ:

```sql
JOIN SyncSession ss ON ss.token = o.sync_token
  AND (ss.status = 'committed' OR ss.token = :T)
```

これにより、他 origin の未確定（half-write）状態の観測が判定を汚染することを防ぐ。

### 原子性の保証

| セットサイズ | 戦略 |
|---|---|
| 小規模（≤数十件） | start → 1 chunk → commit を**1 batch() = 1トランザクション**で完全原子実行 |
| 大規模 | 工程 3〜7 を `LIMIT` ウィンドウで分割。同一トークン再送で続きから収束 |

### Mid-commit クラッシュの回復

大規模 commit 途中でクラッシュした場合:
1. **新しい start は不要** — 同一トークンで commit を再送する
2. 全工程が冪等設計のため、完了済み工程は no-op で通過し、未完了工程から処理再開
3. セッションは active のまま（committed への遷移は最後の1文）
4. スライディング失効により、処理中のセッションが外部から奪われることはない

### エラーレスポンス

| 状況 | HTTP | エラーコード | 衛星の対応 |
|---|---|---|---|
| 同一 origin の active セッションが存在 | 409 | `DUPLICATE_SYNC_SESSION` | 既存セッションの commit/失効を待つ |
| セッション失効 | 410 | `SESSION_EXPIRED` | 新しい start から再開 |
| トークンのプロジェクト不一致 | 403 | `CROSS_TENANT` | 設定を見直す |
| レートリミット超過 | 429 | `RATE_LIMITED` | `Retry-After` ヘッダに従う |
| chunk サイズ超過 | 422 | `VALIDATION_FAILED` | `max_chunk_size` 以下に分割 |
| OCC 競合（commit 内部） | — | — | 発生しない（commit はシステム操作で OCC 非対象） |

---

## 衛星実装ガイド

### 基本的な実装パターン

```python
# 擬似コード: 衛星の同期クライアント

def sync(project_id, origin, observations):
    # 1. セッション開始
    session = post(f"/api/v1/projects/{project_id}/sync/start", {"origin": origin})
    token = session["sync_token"]
    max_size = session["max_chunk_size"]

    # 2. 観測を chunk で送信
    for batch in chunk(observations, max_size):
        result = post(f"/api/v1/projects/{project_id}/sync/{token}/chunk", {"observations": batch})
        # ネットワークエラー時はそのまま再送（冪等）

    # 3. commit（完了まで繰り返し）
    more = True
    mappings = []
    while more:
        result = post(f"/api/v1/projects/{project_id}/sync/{token}/commit")
        mappings.extend(result["mappings"])
        more = result["more"]

    return mappings
```

### external_ref の設計指針

`external_ref` は衛星が割り当てるテストケースの安定な識別子。TMS は opaque に扱う。

**推奨:**
- Java: `fully.qualified.ClassName#methodName` や `fully.qualified.ClassName#methodName(paramType)`
- ファイルベース: `path/to/test_file.py::TestClass::test_method`
- 安定性を重視: リネーム時に `external_ref` が変わると別ケースとして認識される

**制約:**
- 長さ ≤ 512文字
- Printable ASCII のみ
- `(project_id, origin, external_ref)` で一意

### fingerprint の設計指針

`fingerprint` はテストケースの「挙動」を表す指紋。TMS は opaque に扱い、完全一致のみで比較する。

**推奨:**
- テストの Given/When/Then の意味的内容をハッシュ化
- パラメータセットの変更も反映
- コメントやフォーマット変更では変わらないように設計
- 例: `sha256(normalize(given + when + then + parameters))`

**重要:** fingerprint が不安定（毎回変わる）だと観測が爆発する。TMS はレートリミットで異常な変化点頻度を検知・ブロックする。

### リトライ戦略

| 操作 | リトライ安全性 | 注意 |
|---|---|---|
| start | 安全（409 なら既存セッション使用） | — |
| chunk | 完全に冪等 | 同一 observations をそのまま再送 |
| commit | 完全に冪等 | 同一トークンで何度でも再送可 |

---

## スライディング失効モデル

### 動作仕様

```
   start           chunk         chunk         commit        commit
     │               │             │             │             │
     ▼               ▼             ▼             ▼             ▼
 ┌───────┐      ┌───────┐    ┌───────┐    ┌───────┐    ┌───────┐
 │+10min │      │+10min │    │+10min │    │+10min │    │committed
 └───────┘      └───────┘    └───────┘    └───────┘    └───────┘
  expires_at     expires_at   expires_at   expires_at
```

- 各リクエスト（chunk/commit）で `expires_at = now + 10分` に延長
- 衛星が正常に動作している限りセッションは失効しない
- 衛星が突然死した場合、最大10分で自動解放

### 失効の執行

**プライマリ（遅延評価）:** start/chunk/commit の各エントリポイントで、対象 `(project_id, origin)` の active セッションに `now > expires_at` のものがあれば、その場で `expired` に倒す。

**セカンダリ（Cron sweep）:** 定期的に全テーブルをスキャンし、表示整合と掃除を行う。正しさはプライマリが保証し、Cron は補助。

---

## D1 制約への対応まとめ

| 制約 | 対策 |
|---|---|
| インタラクティブ TX 非対応 | batch() による単一トランザクション、部分一意索引でDB委譲 |
| 1文あたり bind ≤ 100 | set-based 文はバインド定数個。chunk は ≤16行/文 |
| 1リクエスト queries 上限 | 8工程を LIMIT ウィンドウで分割、再送で続行 |
| 行サイズ 2MB | observed のバイトサイズを Zod で検証 |
| DB容量 10GB | 変化点のみ記録 + 定期パージ + 容量監視 |
| 単一ライタ | chunk は append のみ（競合最小化）、commit の集合文で効率化 |
| UPDATE … LIMIT | D1 サポート済。冪等 WHERE 前提で移植互換テスト必須 |
