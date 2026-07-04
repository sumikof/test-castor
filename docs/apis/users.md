# ユーザー管理 API

## 概要

組織内のユーザーを管理するAPI群。ユーザーの一覧取得・作成・更新・パスワードリセットを提供する。すべてのエンドポイントは admin ロールを必要とする。

## エンドポイント一覧

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| GET | `/api/v1/users` | ユーザー一覧 | admin |
| POST | `/api/v1/users` | ユーザー作成 | admin |
| GET | `/api/v1/users/:id` | ユーザー詳細 | admin |
| PATCH | `/api/v1/users/:id` | ユーザー更新（ロール変更等） | admin |
| POST | `/api/v1/users/:id/reset-password` | パスワードリセット（管理者操作） | admin |

---

## GET /api/v1/users

### 説明

組織内のユーザー一覧を返す。

### 認証・認可

セッション Cookie。admin ロール必須。

### リクエスト仕様

なし（クエリパラメータ・ボディともになし）。

### レスポンス仕様

**200 OK**

コレクション応答の統一構造（`{ items }` ラップ）で返す。

各アイテムのフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | ユーザーID |
| email | string | メールアドレス |
| display_name | string | 表示名 |
| role | string | `admin` / `editor` / `viewer` |
| last_login_at | integer (epoch ms) / null | 最終ログイン成功時刻。未ログインなら `null`（スペック D-05） |
| created_at | integer (epoch ms) | 作成日時 |
| updated_at | integer (epoch ms) | 更新日時 |

### レスポンス例

```json
{
  "items": [
    {
      "id": "uuid",
      "email": "tanaka@example.com",
      "display_name": "田中太郎",
      "role": "admin",
      "last_login_at": 1719395600000,
      "created_at": 1719388800000,
      "updated_at": 1719388800000
    }
  ]
}
```

---

## POST /api/v1/users

### 説明

新しいユーザーを作成する。

### 認証・認可

セッション Cookie。admin ロール必須。

### リクエスト仕様

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| email | string | yes | メールアドレス（組織内一意） |
| password | string | yes | 初期パスワード |
| display_name | string | yes | 表示名 |
| role | enum | yes | `admin` / `editor` / `viewer` |

### リクエスト例

```json
{
  "email": "sato@example.com",
  "password": "initial-password",
  "display_name": "佐藤花子",
  "role": "editor"
}
```

### レスポンス仕様

**201 Created**

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | ユーザーID |
| email | string | メールアドレス |
| display_name | string | 表示名 |
| role | string | 割り当てられたロール |
| last_login_at | integer (epoch ms) / null | 最終ログイン成功時刻。作成直後は必ず `null`（スペック D-05） |
| created_at | integer (epoch ms) | 作成日時 |
| updated_at | integer (epoch ms) | 更新日時 |

### レスポンス例

```json
{
  "id": "uuid",
  "email": "sato@example.com",
  "display_name": "佐藤花子",
  "role": "editor",
  "last_login_at": null,
  "created_at": 1719388800000,
  "updated_at": 1719388800000
}
```

### エラー

| エラーコード | HTTP | 条件 |
|---|---|---|
| `VALIDATION_FAILED` | 422 | メールアドレス重複、入力値不正等 |

---

## GET /api/v1/users/:id

### 説明

ユーザーの詳細情報を返す。

### 認証・認可

セッション Cookie。admin ロール必須。

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| id | string (UUID) | ユーザーID |

### リクエスト仕様

なし。

### レスポンス仕様

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | ユーザーID |
| email | string | メールアドレス |
| display_name | string | 表示名 |
| role | string | `admin` / `editor` / `viewer` |
| last_login_at | integer (epoch ms) / null | 最終ログイン成功時刻。未ログインなら `null`（スペック D-05） |
| created_at | integer (epoch ms) | 作成日時 |
| updated_at | integer (epoch ms) | 更新日時 |

### レスポンス例

```json
{
  "id": "uuid",
  "email": "sato@example.com",
  "display_name": "佐藤花子",
  "role": "editor",
  "last_login_at": 1719395600000,
  "created_at": 1719388800000,
  "updated_at": 1719388800000
}
```

### エラー

| エラーコード | HTTP | 条件 |
|---|---|---|
| `NOT_FOUND` | 404 | 指定IDのユーザーが存在しない、またはテナント境界違反 |

---

## PATCH /api/v1/users/:id

### 説明

ユーザー情報を更新する。ロール変更時は対象ユーザーの全セッションが無効化される。

### 認証・認可

セッション Cookie。admin ロール必須。

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| id | string (UUID) | ユーザーID |

### リクエスト仕様

PATCHセマンティクス（キー未指定=不変、明示的null=クリア）に従う。詳細は [api-reference.md](../api-reference.md#patch-セマンティクス) を参照。

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| role | enum | no | `admin` / `editor` / `viewer` |
| display_name | string | no | 表示名 |

### リクエスト例

```json
{
  "role": "admin",
  "display_name": "佐藤花子（リーダー）"
}
```

### レスポンス仕様

**200 OK**

更新後のユーザー情報（GET /api/v1/users/:id と同一構造）。

### レスポンス例

```json
{
  "id": "uuid",
  "email": "sato@example.com",
  "display_name": "佐藤花子（リーダー）",
  "role": "admin",
  "last_login_at": 1719395600000,
  "created_at": 1719388800000,
  "updated_at": 1719392400000
}
```

### エラー

| エラーコード | HTTP | 条件 |
|---|---|---|
| `NOT_FOUND` | 404 | 指定IDのユーザーが存在しない、またはテナント境界違反 |
| `VALIDATION_FAILED` | 422 | 「最後の admin」保護（組織内の admin が 0 人になる role 変更は拒否する。自己降格・他者降格を区別しない） |

### 副作用・業務ルール

- `role` が変更された場合、対象ユーザーの全セッションを無効化する
- 次回ログイン時から新ロールが適用される

---

## POST /api/v1/users/:id/reset-password

### 説明

管理者が対象ユーザーのパスワードを手動でリセットする。MVP 向け（セルフサービスリセットが未実装のため）。

### 認証・認可

セッション Cookie。admin ロール必須。

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| id | string (UUID) | 対象ユーザーID |

### リクエスト仕様

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| new_password | string | yes | 新しいパスワード |

### リクエスト例

```json
{
  "new_password": "temporary-password"
}
```

### レスポンス仕様

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| message | string | 常に `"password_reset"` |

### レスポンス例

```json
{
  "message": "password_reset"
}
```

### 副作用・業務ルール

- 対象ユーザーの全セッションを無効化する
- パスワードポリシーへの適合チェックが適用される

---

## 共通仕様

日時表現・エラースキーマ等の共通仕様は [api-reference.md](../api-reference.md) を参照。
