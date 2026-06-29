# TMS Web Service API リファレンス

## このドキュメントについて

TMS Web Service が公開する REST API の仕様書。UI層・衛星サービスの両方がこの API を通じてテストケースを操作する。

衛星同期プロトコル（`/sync/*`）については [sync-protocol.md](./sync-protocol.md) を参照。
認証・認可の詳細については [auth-security.md](./auth-security.md) を参照。

---

## 共通仕様

### ベースパス

すべてのエンドポイントは `/api/v1/` 配下に配置する。

```
/api/v1/projects
/api/v1/projects/:pid/testcases
/api/v1/projects/:pid/testcases/:id
...
```

### リソース階層化（IDOR 防止）

すべてのリソースは `projects/:pid` 配下に階層化する。フラットパス（例: `/api/testcases/:id`）は提供しない。

共通前段ミドルウェアが `id → project_id → organization_id` を1クエリで解決し、リクエスタのスコープと不一致なら **404**（存在隠蔽）を返す。

### 日時表現

すべての日時値は JSON 上で **epoch ms（ミリ秒単位の整数）** として表現する。

```json
{ "created_at": 1719388800000, "updated_at": 1719392400000 }
```

### コレクション応答の統一構造

すべてのコレクション系レスポンスは `{ items, ... }` でラップする（将来のページング追加を非破壊化）。

```json
{
  "items": [...],
  "next_cursor": "eyJjcmVhdGVkX2F0IjoxNzE5...",
  "has_more": true
}
```

### カーソルベースページング

- タイブレーカー: `(created_at, id)` の安定ソート
- レスポンス: `{ items, next_cursor, has_more }`
- `total` は重い場合は任意/概算（必須ではない）
- `next_cursor` が `null` または `has_more: false` で末尾

### バージョニング規約

| 変更種別 | 扱い |
|---|---|
| 任意フィールドの追加 | 非破壊（同一バージョン `v1` 内） |
| 必須フィールドの追加・改名・削除 | 新バージョン（`v2`）でのみ |
| 未知フィールド | Zod `strip` で無視（エラーにしない） |

---

## 統一エラースキーマ

すべてのエラーレスポンスは以下の統一構造で返す。

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "title is required",
    "details": [
      { "path": "title", "msg": "Required" }
    ],
    "retryable": false
  }
}
```

### 安定エラーコード

| code | HTTP | 意味 |
|---|---|---|
| `VALIDATION_FAILED` | 422 | 入力値バリデーションエラー |
| `OCC_CONFLICT` | 409 | 楽観的排他制御の競合（version不一致） |
| `DUPLICATE_SYNC_SESSION` | 409 | 同一 `(project_id, origin)` の能動セッションが既存 |
| `CROSS_TENANT` | 403/404 | テナント境界違反（存在隠蔽のため通常は404） |
| `NOT_FOUND` | 404 | リソースが存在しない |
| `SESSION_EXPIRED` | 410 | 同期セッションが失効済み |
| `RATE_LIMITED` | 429 | レート制限超過 |
| `UNAUTHORIZED` | 401 | 認証失敗 |

409 の二義性（OCC vs 同期セッション重複）は `code` フィールドで分離する。衛星は `code` に基づいて自動回復分岐を実装できる。

---

## 楽観的排他制御（OCC）

テストケースの並行更新を防ぐ。

- **GET レスポンス:** 現在の `version` を弱 ETag で返す
  ```
  ETag: W/"3"
  ```
- **PATCH リクエスト:** `If-Match` ヘッダで version を指定
  ```
  If-Match: "3"
  ```
- **不一致時:** `409 OCC_CONFLICT` を返す

`version` は人間所有列（title, target, category, given, when, then, parameters, status, confidence, metadata）の更新時のみインクリメントされる。衛星同期によるシステム可変列の更新では bump しない。

---

## PATCH セマンティクス

| フィールドの状態 | 意味 |
|---|---|
| キーが存在し値を持つ | そのフィールドを更新 |
| キーが未指定 | そのフィールドは不変 |
| キーに明示的 `null` | そのフィールドをクリア |

```json
{
  "title": "新しいタイトル",
  "target": null,
  "given": "更新された事前条件"
}
```

上記の例: `title` と `given` を更新、`target` をクリア、他のフィールドは不変。

---

## エンドポイント一覧

### プロジェクト

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| GET | `/api/v1/projects` | プロジェクト一覧 | viewer |
| POST | `/api/v1/projects` | プロジェクト作成 | admin |

#### GET /api/v1/projects

プロジェクト一覧を返す。

**レスポンス 200:**
```json
{
  "items": [
    {
      "id": "uuid",
      "name": "payment-service",
      "repo_url": "https://github.com/example/payment",
      "created_at": 1719388800000,
      "updated_at": 1719388800000
    }
  ]
}
```

#### POST /api/v1/projects

新規プロジェクトを作成する。

**リクエスト:**
```json
{
  "name": "payment-service",
  "repo_url": "https://github.com/example/payment"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| name | string | yes | プロジェクト名 |
| repo_url | string | no | 連携元リポジトリURL |

**レスポンス 201:**
```json
{
  "id": "uuid",
  "name": "payment-service",
  "repo_url": "https://github.com/example/payment",
  "created_at": 1719388800000,
  "updated_at": 1719388800000
}
```

---

### テストケース

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| GET | `/api/v1/projects/:pid/testcases` | テストケース一覧 | viewer |
| POST | `/api/v1/projects/:pid/testcases` | テストケース作成（手動） | editor |
| GET | `/api/v1/projects/:pid/testcases/:id` | 単体取得 | viewer |
| PATCH | `/api/v1/projects/:pid/testcases/:id` | 編集（status変更含む） | editor |
| DELETE | `/api/v1/projects/:pid/testcases/:id` | アーカイブ | editor |
| GET | `/api/v1/projects/:pid/testcases/:id/history` | 変更履歴 | viewer |
| GET | `/api/v1/projects/:pid/testcases/:id?format=gherkin` | Gherkin ビュー | viewer |

#### GET /api/v1/projects/:pid/testcases

テストケース一覧。カーソルページング対応。

**クエリパラメータ:**

| パラメータ | 型 | 説明 |
|---|---|---|
| status | string | `draft` / `approved` / `archived` でフィルタ |
| category | string | `normal` / `abnormal` / `boundary` / `error_handling` でフィルタ |
| is_stale | boolean | stale フラグでフィルタ |
| cursor | string | ページングカーソル |
| limit | integer | 1ページあたりの件数（既定値は実装で決定） |

**レスポンス 200:**
```json
{
  "items": [
    {
      "id": "uuid",
      "title": "正常な支払い処理",
      "target": "com.example.PaymentService#charge",
      "category": "normal",
      "status": "draft",
      "ownership": "machine",
      "is_stale": false,
      "drift": false,
      "version": 1,
      "created_at": 1719388800000,
      "updated_at": 1719388800000
    }
  ],
  "next_cursor": "eyJjcmVhdGVkX2F0IjoxNzE5...",
  "has_more": true
}
```

#### POST /api/v1/projects/:pid/testcases

手動でテストケースを作成する。`ownership=human`、`created_origin=manual` で作成される。

**リクエスト:**
```json
{
  "title": "残高不足時にエラーを返す",
  "target": "com.example.PaymentService#charge",
  "category": "error_handling",
  "given": "ユーザーの残高が100円未満",
  "when": "1000円の支払いを実行",
  "then": "InsufficientBalanceError が発生する",
  "parameters": [
    { "inputs": { "balance": 50, "amount": 1000 }, "expected": "error" },
    { "inputs": { "balance": 0, "amount": 500 }, "expected": "error" }
  ],
  "status": "draft",
  "metadata": { "tags": ["payment", "error"] }
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| title | string | yes | テストケース名 |
| target | string | no | 対象メソッド/クラス |
| category | enum | yes | `normal` / `abnormal` / `boundary` / `error_handling` |
| given | string | yes | 事前条件 |
| when | string | yes | 操作 |
| then | string | yes | 期待結果 |
| parameters | array | no | パラメータ化テストのデータセット `[{name?, inputs, expected}]` |
| status | enum | no | 既定 `draft`。`draft` / `approved` / `archived` |
| confidence | number | no | 信頼度（0.0〜1.0） |
| source_ref | object | no | 出所参照（file/line/commit等） |
| metadata | object | no | 任意メタデータ（タグ等） |

**レスポンス 201:** 作成されたテストケースの全フィールド。

#### GET /api/v1/projects/:pid/testcases/:id

テストケースの詳細を取得する。レスポンスヘッダに弱 ETag を含む。

**レスポンスヘッダ:**
```
ETag: W/"3"
```

**レスポンス 200:**
```json
{
  "id": "uuid",
  "title": "正常な支払い処理",
  "target": "com.example.PaymentService#charge",
  "category": "normal",
  "given": "ユーザーの残高が十分にある",
  "when": "500円の支払いを実行",
  "then": "支払いが成功し残高が500円減少する",
  "parameters": null,
  "status": "approved",
  "is_stale": false,
  "ownership": "human",
  "mirror_origin": "discovery-v1",
  "drift": false,
  "fingerprint": "abc123...",
  "version": 3,
  "confidence": 0.95,
  "source_ref": { "file": "PaymentService.java", "line": 42 },
  "created_origin": "discovery",
  "metadata": { "tags": ["payment"] },
  "created_at": 1719388800000,
  "updated_at": 1719392400000
}
```

#### PATCH /api/v1/projects/:pid/testcases/:id

テストケースを編集する。OCC による排他制御が必須。

**リクエストヘッダ（必須）:**
```
If-Match: "3"
```

**リクエスト:**
```json
{
  "title": "更新されたタイトル",
  "status": "approved"
}
```

**レスポンス 200:** 更新後のテストケース全フィールド + 新しい ETag。

**エラー:**
- `409 OCC_CONFLICT` — version 不一致（他のユーザーが先に更新した）
- `If-Match` ヘッダ未指定時は `428 Precondition Required`

**ownership 遷移:**
`ownership=machine` のテストケースに対して人間所有列の値が実際に変化する PATCH を行うと、`ownership` が `machine → human` に不可逆遷移する（同値・no-op PATCH では遷移しない）。

#### DELETE /api/v1/projects/:pid/testcases/:id

テストケースをアーカイブする（物理削除は提供しない）。`status=archived` に変更される。

**レスポンス 200:** アーカイブ後のテストケース。

物理削除を行わない理由: identity 消滅により、再同期で同じテストケースがゾンビとして復活するのを防ぐ。

#### GET /api/v1/projects/:pid/testcases/:id/history

変更履歴を返す。カーソルページング対応。

**レスポンス 200:**
```json
{
  "items": [
    {
      "id": "uuid",
      "test_case_id": "uuid",
      "actor": "user:uuid-of-user",
      "action": "updated",
      "delta": {
        "title": {
          "before": "旧タイトル",
          "after": "新タイトル"
        }
      },
      "created_at": 1719392400000
    }
  ],
  "next_cursor": null,
  "has_more": false
}
```

| フィールド | 説明 |
|---|---|
| actor | 型付き参照。`user:<id>` または `token:<id>` |
| action | `created` / `updated` / `status_changed` / `imported` |
| delta | 変更フィールドのみの差分 `{field: {before, after}}` |

#### GET /api/v1/projects/:pid/testcases/:id?format=gherkin

Gherkin/自然言語形式の派生ビューを返す。

**レスポンスヘッダ:**
```
Content-Type: text/plain; charset=utf-8
```

**レスポンス 200:**
```gherkin
Feature: 正常な支払い処理

  Scenario: 500円の支払いが成功する
    Given ユーザーの残高が十分にある
    When 500円の支払いを実行
    Then 支払いが成功し残高が500円減少する
```

---

### API トークン管理

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| POST | `/api/v1/projects/:pid/tokens` | トークン発行 | admin |
| GET | `/api/v1/projects/:pid/tokens` | トークン一覧 | admin |
| DELETE | `/api/v1/projects/:pid/tokens/:id` | トークン失効 | admin |

#### POST /api/v1/projects/:pid/tokens

APIトークンを発行する。平文は**この応答でのみ1回だけ**返される。以後は取得不可。

**リクエスト:**
```json
{
  "name": "discovery-satellite-prod"
}
```

**レスポンスヘッダ:**
```
Cache-Control: no-store
```

**レスポンス 201:**
```json
{
  "id": "uuid",
  "name": "discovery-satellite-prod",
  "token": "tms_base64url-encoded-32bytes-or-more",
  "created_at": 1719388800000
}
```

`token` フィールドは発行レスポンスのみに含まれる。ログ・履歴・エラーボディには一切含めない。

#### GET /api/v1/projects/:pid/tokens

発行済みトークンの一覧。平文・ハッシュは返さない。

**レスポンス 200:**
```json
{
  "items": [
    {
      "id": "uuid",
      "name": "discovery-satellite-prod",
      "created_at": 1719388800000,
      "revoked_at": null,
      "last_used_at": 1719450000000
    }
  ]
}
```

#### DELETE /api/v1/projects/:pid/tokens/:id

トークンをソフト失効させる（`revoked_at` を記録）。失効済みトークンでの認証は即座に `401` となる。

**レスポンス 200:**
```json
{
  "id": "uuid",
  "name": "discovery-satellite-prod",
  "revoked_at": 1719460000000
}
```

---

## 冪等性

### Idempotency-Key ヘッダ

同期プロトコルの `chunk`/`commit` エンドポイントでは `Idempotency-Key` ヘッダを受け付ける。構造的冪等性（一意制約 + ON CONFLICT DO NOTHING、全工程の冪等述語）への多重防御として機能する。

```
Idempotency-Key: "client-generated-unique-key"
```

短期メモ化により、同一キーでの再送は前回と同じ応答を返す。

---

## origin 正規化規約

`origin` はテナント内で衛星を一意に識別する文字列。mirror 権威・stale 判定が完全一致に依存するため、以下のルールで正規化する。

| ルール | 説明 |
|---|---|
| 小文字 | 大文字は受け付けない（Zod で検証） |
| 許可文字 | `[a-z0-9\-_.]` のみ |
| 既知プレフィックス推奨 | `discovery-`, `testgen-`, `selfhealing-` など |
| 最大長 | 128文字 |

例: `discovery-v1`, `testgen-junit.prod`, `selfhealing-ci`

---

## 関連ドキュメント

- [sync-protocol.md](./sync-protocol.md) — 衛星同期プロトコル（start/chunk/commit）
- [auth-security.md](./auth-security.md) — 認証・認可・テナント境界
- [data-model.md](./data-model.md) — エンティティ定義・状態機械
- [architecture.md](./architecture.md) — 全体アーキテクチャ
- [usecase.md](./usecase.md) — ユースケース集
