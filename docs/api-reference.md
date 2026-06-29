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

### 初期セットアップ

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| POST | `/api/v1/setup` | 初回セットアップ | 不要 |

#### POST /api/v1/setup

初回デプロイ直後に組織と管理者アカウントを作成する。Organization が 0 件のときのみ実行可能。

**認証:** 不要（Organization 未存在が前提条件）

**リクエスト:**
```json
{
  "organization_name": "株式会社Example",
  "admin_email": "admin@example.com",
  "admin_password": "secure-password-here",
  "admin_display_name": "管理太郎"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| organization_name | string | yes | 組織名 |
| admin_email | string | yes | 管理者メールアドレス |
| admin_password | string | yes | 管理者パスワード |
| admin_display_name | string | yes | 管理者の表示名 |

**レスポンス 201:**
```json
{
  "organization": {
    "id": "uuid",
    "name": "株式会社Example",
    "created_at": 1719388800000
  },
  "user": {
    "id": "uuid",
    "email": "admin@example.com",
    "display_name": "管理太郎",
    "role": "admin",
    "created_at": 1719388800000
  }
}
```

**エラー:**
- `409 SETUP_ALREADY_COMPLETE` — Organization が既に存在する

---

### 認証

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| POST | `/api/v1/auth/login` | ログイン | 不要 |
| POST | `/api/v1/auth/logout` | ログアウト | セッション Cookie |
| GET | `/api/v1/auth/me` | 現在のユーザー情報取得 | セッション Cookie |
| PATCH | `/api/v1/auth/password` | パスワード変更（本人） | セッション Cookie |
| POST | `/api/v1/auth/password-reset-request` | パスワードリセット要求 `[※未実装]` | 不要 |

#### POST /api/v1/auth/login

メールアドレスとパスワードでログインし、セッション Cookie を発行する。

**リクエスト:**
```json
{
  "email": "tanaka@example.com",
  "password": "user-password"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| email | string | yes | メールアドレス |
| password | string | yes | パスワード |

**レスポンスヘッダ:**
```
Set-Cookie: session=<signed-session-id>; HttpOnly; Secure; SameSite=Lax; Path=/
```

**レスポンス 200:**
```json
{
  "user": {
    "id": "uuid",
    "email": "tanaka@example.com",
    "display_name": "田中太郎",
    "role": "editor"
  }
}
```

**エラー:**
- `401 UNAUTHORIZED` — 認証失敗（メールアドレスの存在有無を漏洩しない統一メッセージ）
- `429 RATE_LIMITED` — ブルートフォース防御による制限

**セキュリティ:**
- ログイン成功時にセッション ID を必ず再発行する（セッション固定攻撃対策）
- `(account, IP)` 別の永続カウンタでブルートフォースを防御

#### POST /api/v1/auth/logout

現在のセッションを無効化する。

**認証:** セッション Cookie（任意 role）

**リクエスト:** ボディなし

**レスポンス 204:** セッション削除完了（ボディなし）

#### GET /api/v1/auth/me

現在ログイン中のユーザー情報を返す。

**認証:** セッション Cookie（任意 role）

**レスポンス 200:**
```json
{
  "id": "uuid",
  "email": "tanaka@example.com",
  "display_name": "田中太郎",
  "role": "editor",
  "organization_id": "uuid"
}
```

**エラー:**
- `401 UNAUTHORIZED` — 未認証（Cookie なし or セッション失効）

#### PATCH /api/v1/auth/password

本人がパスワードを変更する。変更後、自身の現在のセッション以外の全セッションが無効化される。

**認証:** セッション Cookie（任意 role）

**リクエスト:**
```json
{
  "current_password": "old-password",
  "new_password": "new-secure-password"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| current_password | string | yes | 現在のパスワード |
| new_password | string | yes | 新しいパスワード |

**レスポンス 200:**
```json
{
  "message": "password_changed"
}
```

**エラー:**
- `401 UNAUTHORIZED` — 現在のパスワードが不正
- `422 VALIDATION_FAILED` — 新しいパスワードがポリシー不適合

**副作用:** 当該ユーザーの他の全セッションを無効化する（`DELETE FROM Session WHERE user_id = ? AND id != ?`）

#### POST /api/v1/auth/password-reset-request `[※未実装]`

パスワードリセット用のメールを送信する。MVP 後の実装予定（メール送信基盤が必要）。MVP では管理者による手動リセット（`POST /api/v1/users/:id/reset-password`）で代替する。

**認証:** 不要

**リクエスト:**
```json
{
  "email": "tanaka@example.com"
}
```

**レスポンス 200:**

```json
{
  "message": "reset_email_sent"
}
```

メールアドレスの存在有無に関わらず同一レスポンスを返す（タイミング攻撃・列挙攻撃の防止）。

---

### ユーザー管理

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| GET | `/api/v1/users` | ユーザー一覧 | admin |
| POST | `/api/v1/users` | ユーザー作成 | admin |
| GET | `/api/v1/users/:id` | ユーザー詳細 | admin |
| PATCH | `/api/v1/users/:id` | ユーザー更新（ロール変更等） | admin |
| POST | `/api/v1/users/:id/reset-password` | パスワードリセット（管理者操作） | admin |

#### GET /api/v1/users

組織内のユーザー一覧を返す。

**レスポンス 200:**
```json
{
  "items": [
    {
      "id": "uuid",
      "email": "tanaka@example.com",
      "display_name": "田中太郎",
      "role": "admin",
      "created_at": 1719388800000,
      "updated_at": 1719388800000
    }
  ]
}
```

#### POST /api/v1/users

新しいユーザーを作成する。

**リクエスト:**
```json
{
  "email": "sato@example.com",
  "password": "initial-password",
  "display_name": "佐藤花子",
  "role": "editor"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| email | string | yes | メールアドレス（org 内一意） |
| password | string | yes | 初期パスワード |
| display_name | string | yes | 表示名 |
| role | enum | yes | `admin` / `editor` / `viewer` |

**レスポンス 201:**
```json
{
  "id": "uuid",
  "email": "sato@example.com",
  "display_name": "佐藤花子",
  "role": "editor",
  "created_at": 1719388800000,
  "updated_at": 1719388800000
}
```

**エラー:**
- `422 VALIDATION_FAILED` — メールアドレス重複等

#### GET /api/v1/users/:id

ユーザーの詳細情報を返す。

**レスポンス 200:**
```json
{
  "id": "uuid",
  "email": "sato@example.com",
  "display_name": "佐藤花子",
  "role": "editor",
  "created_at": 1719388800000,
  "updated_at": 1719388800000
}
```

#### PATCH /api/v1/users/:id

ユーザー情報を更新する。ロール変更時は対象ユーザーの全セッションが無効化される。

**リクエスト:**
```json
{
  "role": "admin",
  "display_name": "佐藤花子（リーダー）"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| role | enum | no | `admin` / `editor` / `viewer` |
| display_name | string | no | 表示名 |

**レスポンス 200:** 更新後のユーザー情報。

**副作用:** `role` が変更された場合、対象ユーザーの全セッションを無効化する（次回ログイン時から新ロールが適用される）。

#### POST /api/v1/users/:id/reset-password

管理者が対象ユーザーのパスワードを手動でリセットする。MVP 向け（セルフサービスリセットが未実装のため）。

**リクエスト:**
```json
{
  "new_password": "temporary-password"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| new_password | string | yes | 新しいパスワード |

**レスポンス 200:**
```json
{
  "message": "password_reset"
}
```

**副作用:** 対象ユーザーの全セッションを無効化する。

---

### プロジェクト

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| GET | `/api/v1/projects` | プロジェクト一覧 | viewer |
| POST | `/api/v1/projects` | プロジェクト作成 | admin |
| PATCH | `/api/v1/projects/:pid` | プロジェクト更新 | admin |

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

#### PATCH /api/v1/projects/:pid

プロジェクト情報を更新する。

**リクエスト:**
```json
{
  "name": "payment-service-v2",
  "repo_url": "https://github.com/example/payment-v2"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| name | string | no | プロジェクト名 |
| repo_url | string | no | 連携元リポジトリURL（`null` でクリア） |

**レスポンス 200:** 更新後のプロジェクト情報。

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
| POST | `/api/v1/projects/:pid/testcases/:id/accept-fingerprint` | drift 解消 | editor |
| GET | `/api/v1/projects/:pid/testcases/:id/identities` | Identity 情報 | viewer |
| GET | `/api/v1/projects/:pid/testcases/:id/observations` | 観測履歴 | viewer |
| GET | `/api/v1/projects/:pid/testcases/:id/diff` | 構造化 Diff | viewer |
| POST | `/api/v1/projects/:pid/testcases/bulk` | 一括操作 | editor |

#### GET /api/v1/projects/:pid/testcases

テストケース一覧。カーソルページング対応。

**クエリパラメータ:**

| パラメータ | 型 | 説明 |
|---|---|---|
| status | string | `draft` / `approved` / `archived` でフィルタ |
| category | string | `normal` / `abnormal` / `boundary` / `error_handling` でフィルタ |
| ownership | string | `machine` / `human` でフィルタ |
| drift | boolean | drift フラグでフィルタ |
| is_stale | boolean | stale フラグでフィルタ |
| target | string | 対象クラス・メソッド名の部分一致検索（例: `PaymentService`） |
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

#### POST /api/v1/projects/:pid/testcases/:id/accept-fingerprint

drift を解消する。最新 committed 観測の指紋を canonical に採用し、`drift=false` に更新する。OCC による排他制御が必須。

**リクエストヘッダ（必須）:**
```
If-Match: "3"
```

**リクエスト:** ボディなし

**レスポンス 200:**
```json
{
  "id": "uuid",
  "fingerprint": "sha256:new-fingerprint...",
  "drift": false,
  "version": 4,
  "updated_at": 1719392400000
}
```

**処理内容:**
1. 最新 committed 観測（`mirror_origin` 由来）の指紋を取得する
2. canonical の `fingerprint` を観測の指紋で更新する
3. `drift = false` に設定する
4. `version` を +1 する（人間所有列の明示的操作のため）
5. TestCaseHistory に `status_changed` として記録する

**エラー:**
- `409 OCC_CONFLICT` — version 不一致
- `422 NO_DRIFT` — drift が発生していないテストケースに対する実行
- `428 PRECONDITION_REQUIRED` — `If-Match` ヘッダ未指定

---

#### GET /api/v1/projects/:pid/testcases/:id/identities

テストケースに紐づく per-origin の同定情報を返す。構造化 Diff や stale 状態のドリルダウン表示に使用する。

**レスポンス 200:**
```json
{
  "items": [
    {
      "id": "uuid",
      "origin": "discovery-v1",
      "external_ref": "com.example.PaymentServiceTest#testCharge_success",
      "is_stale": false,
      "last_seen_at": 1719392400000,
      "created_at": 1719388800000
    },
    {
      "id": "uuid",
      "origin": "discovery-v2",
      "external_ref": "com.example.PaymentServiceTest#testCharge_success",
      "is_stale": true,
      "last_seen_at": 1718000000000,
      "created_at": 1718000000000
    }
  ]
}
```

| フィールド | 説明 |
|---|---|
| origin | 観測元の衛星識別子 |
| external_ref | 当該オリジンの参照 ID |
| is_stale | per-origin の stale 状態（true = 直近の同期で未出現） |
| last_seen_at | 直近の出現確認時刻 |

---

#### GET /api/v1/projects/:pid/testcases/:id/observations

テストケースの committed 観測を時系列で返す。カーソルページング対応。

**クエリパラメータ:**

| パラメータ | 型 | 説明 |
|---|---|---|
| origin | string | 特定 origin でフィルタ（任意） |
| cursor | string | ページングカーソル |
| limit | integer | 1ページあたりの件数 |

**レスポンス 200:**
```json
{
  "items": [
    {
      "id": "uuid",
      "origin": "discovery-v1",
      "fingerprint": "sha256:a1b2c3d4...",
      "observed": {
        "given": "有効なクレジットカードが登録済み",
        "when": "charge(1000) を呼び出す",
        "then": "決済成功レスポンスが返る",
        "parameters": [],
        "source_ref": {"file": "PaymentServiceTest.java", "line": 42},
        "schema_version": "1.0"
      },
      "created_at": 1719392400000
    }
  ],
  "next_cursor": null,
  "has_more": false
}
```

committed セッション由来の観測のみを対象とする（active/expired セッション由来の観測は意味論的に除外）。

---

#### GET /api/v1/projects/:pid/testcases/:id/diff

canonical（現在のテスト仕様）と最新 committed 観測の構造化差分を返す。drift が発生しているテストケースの差分確認に使用する。

**レスポンス 200:**
```json
{
  "has_drift": true,
  "origin": "discovery-v1",
  "observed_at": 1719392400000,
  "canonical": {
    "given": "カート内に商品が1点ある",
    "when": "注文確定ボタンを押す",
    "then": "合計金額が表示される",
    "parameters": null
  },
  "latest_observation": {
    "given": "カート内に商品が1点以上ある",
    "when": "注文確定ボタンを押す",
    "then": "合計金額と送料が表示される",
    "parameters": null
  },
  "diff": {
    "given": {
      "before": "カート内に商品が1点ある",
      "after": "カート内に商品が1点以上ある"
    },
    "then": {
      "before": "合計金額が表示される",
      "after": "合計金額と送料が表示される"
    }
  }
}
```

| フィールド | 説明 |
|---|---|
| has_drift | drift 発生中なら `true` |
| origin | 最新観測の origin |
| observed_at | 最新観測の時刻 |
| canonical | 現在のテスト仕様（given/when/then/parameters） |
| latest_observation | 最新 committed 観測の内容 |
| diff | 差分があるフィールドのみの before/after。差分なしのフィールドは含まない |

**drift 未発生時:** `has_drift: false` で canonical のみ返し、`latest_observation` / `diff` は `null`。

---

#### POST /api/v1/projects/:pid/testcases/bulk

複数のテストケースに対して一括でステータス変更を実行する。

**リクエスト:**
```json
{
  "ids": ["uuid-1", "uuid-2", "uuid-3"],
  "action": "approve"
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| ids | string[] | yes | 対象テストケースの ID 配列（最大 100 件） |
| action | enum | yes | `approve` / `archive` / `restore` |

**レスポンス 200:**
```json
{
  "updated": 15,
  "skipped": 2,
  "errors": [
    {
      "id": "uuid-16",
      "code": "OCC_CONFLICT",
      "message": "version mismatch"
    }
  ]
}
```

| フィールド | 説明 |
|---|---|
| updated | 正常に更新されたテストケース数 |
| skipped | 既に対象ステータスのためスキップされた件数 |
| errors | 個別のエラー（OCC 競合等） |

**`approve` アクション:**
- `status` を `approved` に変更する
- `ownership=machine` のテストケースは `human` に不可逆遷移する
- 各テストケースに個別の TestCaseHistory エントリを記録する

**`archive` アクション:**
- `status` を `archived` に変更する
- 各テストケースに個別の TestCaseHistory エントリを記録する

**`restore` アクション:**
- `archived` のテストケースを `draft` に復帰する
- `archived` 以外のテストケースはスキップされる
- 各テストケースに個別の TestCaseHistory エントリを記録する

**制約:**
- 1 リクエストあたり最大 100 件
- `archived` のテストケースに `approve` は実行できない（`restore` で `draft` に復帰してから承認する）
- OCC は使用しない（一括操作の利便性を優先）。個別の競合はベストエフォートで処理し、`errors` で報告する

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
- [screens.md](./screens.md) — 画面一覧・画面遷移図
