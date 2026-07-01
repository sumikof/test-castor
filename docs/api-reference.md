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
| `SETUP_ALREADY_COMPLETE` | 409 | 初期セットアップ済み |
| `PRECONDITION_REQUIRED` | 428 | If-Match ヘッダ未指定 |
| `NO_DRIFT` | 422 | drift 未発生のテストケースに accept-fingerprint を実行 |

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

各APIグループの詳細仕様は個別ドキュメントを参照。

### 初期セットアップ

→ 詳細: [apis/setup.md](./apis/setup.md)

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| POST | `/api/v1/setup` | 初回セットアップ | 不要 |

### 認証

→ 詳細: [apis/auth.md](./apis/auth.md)

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| POST | `/api/v1/auth/login` | ログイン | 不要 |
| POST | `/api/v1/auth/logout` | ログアウト | セッション Cookie |
| GET | `/api/v1/auth/me` | 現在のユーザー情報取得 | セッション Cookie |
| PATCH | `/api/v1/auth/password` | パスワード変更（本人） | セッション Cookie |
| POST | `/api/v1/auth/password-reset-request` | パスワードリセット要求 `[※未実装]` | 不要 |

### ユーザー管理

→ 詳細: [apis/users.md](./apis/users.md)

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| GET | `/api/v1/users` | ユーザー一覧 | admin |
| POST | `/api/v1/users` | ユーザー作成 | admin |
| GET | `/api/v1/users/:id` | ユーザー詳細 | admin |
| PATCH | `/api/v1/users/:id` | ユーザー更新（ロール変更等） | admin |
| POST | `/api/v1/users/:id/reset-password` | パスワードリセット（管理者操作） | admin |

### プロジェクト

→ 詳細: [apis/projects.md](./apis/projects.md)

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| GET | `/api/v1/projects` | プロジェクト一覧 | viewer |
| POST | `/api/v1/projects` | プロジェクト作成 | admin |
| PATCH | `/api/v1/projects/:pid` | プロジェクト更新 | admin |

### テストケース

→ 詳細: [apis/testcases.md](./apis/testcases.md)

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| GET | `/api/v1/projects/:pid/testcases` | テストケース一覧 | viewer |
| POST | `/api/v1/projects/:pid/testcases` | テストケース作成（手動） | editor |
| GET | `/api/v1/projects/:pid/testcases/:id` | 単体取得 | viewer |
| PATCH | `/api/v1/projects/:pid/testcases/:id` | 編集（status変更含む） | editor |
| DELETE | `/api/v1/projects/:pid/testcases/:id` | アーカイブ | editor |
| GET | `/api/v1/projects/:pid/testcases/:id/history` | 変更履歴 | viewer |
| GET | `/api/v1/projects/:pid/testcases/:id?format=gherkin` | Gherkin ビュー | viewer |
| POST | `/api/v1/projects/:pid/testcases/:id/accept-fingerprint` | drift 解消 | editor |
| GET | `/api/v1/projects/:pid/testcases/:id/identities` | Identity 情報 | viewer |
| GET | `/api/v1/projects/:pid/testcases/:id/observations` | 観測履歴 | viewer |
| GET | `/api/v1/projects/:pid/testcases/:id/diff` | 構造化 Diff | viewer |
| POST | `/api/v1/projects/:pid/testcases/bulk` | 一括操作 | editor |

### API トークン管理

→ 詳細: [apis/tokens.md](./apis/tokens.md)

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| POST | `/api/v1/projects/:pid/tokens` | トークン発行 | admin |
| GET | `/api/v1/projects/:pid/tokens` | トークン一覧 | admin |
| DELETE | `/api/v1/projects/:pid/tokens/:id` | トークン失効 | admin |

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
- [screens.md](./screens.md) — 画面一覧・画面遷移図
