# 認証 API

## 概要

ユーザーのログイン・ログアウト・セッション管理・パスワード変更を提供する認証API群。セッションCookieベースの認証を使用する。

## エンドポイント一覧

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| POST | `/api/v1/auth/login` | ログイン | 不要 |
| POST | `/api/v1/auth/logout` | ログアウト | セッション Cookie |
| GET | `/api/v1/auth/me` | 現在のユーザー情報取得 | セッション Cookie |
| PATCH | `/api/v1/auth/password` | パスワード変更（本人） | セッション Cookie |
| POST | `/api/v1/auth/password-reset-request` | パスワードリセット要求 `[※未実装]` | 不要 |

---

## POST /api/v1/auth/login

### 説明

メールアドレスとパスワードでログインし、セッション Cookie を発行する。

### 認証・認可

認証不要。

### リクエスト仕様

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| email | string | yes | メールアドレス |
| password | string | yes | パスワード |

### リクエスト例

```json
{
  "email": "tanaka@example.com",
  "password": "user-password"
}
```

### レスポンス仕様

**レスポンスヘッダ:**

| ヘッダ | 値 | 説明 |
|---|---|---|
| Set-Cookie | `session=<signed-session-id>; HttpOnly; Secure; SameSite=Lax; Path=/` | セッションCookie |

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| user.id | string (UUID) | ユーザーID |
| user.email | string | メールアドレス |
| user.display_name | string | 表示名 |
| user.role | string | `admin` / `editor` / `viewer` |

### レスポンス例

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

### エラー

| エラーコード | HTTP | 条件 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 認証失敗（メールアドレスの存在有無を漏洩しない統一メッセージ） |
| `RATE_LIMITED` | 429 | ブルートフォース防御による制限 |

### 副作用・業務ルール

- ログイン成功時にセッション ID を必ず再発行する（セッション固定攻撃対策）
- `(account, IP)` 別の永続カウンタでブルートフォースを防御する

---

## POST /api/v1/auth/logout

### 説明

現在のセッションを無効化する。

### 認証・認可

セッション Cookie（任意 role）。

### リクエスト仕様

ボディなし。

### レスポンス仕様

**204 No Content**

セッション削除完了。レスポンスボディなし。

### エラー

| エラーコード | HTTP | 条件 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未認証（Cookie なし or セッション失効） |

---

## GET /api/v1/auth/me

### 説明

現在ログイン中のユーザー情報を返す。

### 認証・認可

セッション Cookie（任意 role）。

### リクエスト仕様

なし（クエリパラメータ・ボディともになし）。

### レスポンス仕様

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | ユーザーID |
| email | string | メールアドレス |
| display_name | string | 表示名 |
| role | string | `admin` / `editor` / `viewer` |
| organization_id | string (UUID) | 所属組織ID |

### レスポンス例

```json
{
  "id": "uuid",
  "email": "tanaka@example.com",
  "display_name": "田中太郎",
  "role": "editor",
  "organization_id": "uuid"
}
```

### エラー

| エラーコード | HTTP | 条件 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未認証（Cookie なし or セッション失効） |

---

## PATCH /api/v1/auth/password

### 説明

本人がパスワードを変更する。変更後、自身の現在のセッション以外の全セッションが無効化される。

### 認証・認可

セッション Cookie（任意 role）。

### リクエスト仕様

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| current_password | string | yes | 現在のパスワード |
| new_password | string | yes | 新しいパスワード |

### リクエスト例

```json
{
  "current_password": "old-password",
  "new_password": "new-secure-password"
}
```

### レスポンス仕様

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| message | string | 常に `"password_changed"` |

### レスポンス例

```json
{
  "message": "password_changed"
}
```

### エラー

| エラーコード | HTTP | 条件 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 現在のパスワードが不正 |
| `VALIDATION_FAILED` | 422 | 新しいパスワードがポリシー不適合 |

### 副作用・業務ルール

- 当該ユーザーの他の全セッションを無効化する（`DELETE FROM Session WHERE user_id = ? AND id != ?`）
- 現在のセッションは維持される（パスワード変更後も再ログイン不要）

---

## POST /api/v1/auth/password-reset-request `[※未実装]`

### 説明

パスワードリセット用のメールを送信する。MVP 後の実装予定（メール送信基盤が必要）。MVP では管理者による手動リセット（`POST /api/v1/users/:id/reset-password`）で代替する。

### 認証・認可

認証不要。

### リクエスト仕様

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| email | string | yes | リセット対象のメールアドレス |

### リクエスト例

```json
{
  "email": "tanaka@example.com"
}
```

### レスポンス仕様

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| message | string | 常に `"reset_email_sent"` |

### レスポンス例

```json
{
  "message": "reset_email_sent"
}
```

### 業務ルール

- メールアドレスの存在有無に関わらず同一レスポンスを返す（タイミング攻撃・列挙攻撃の防止）

---

## 共通仕様

日時表現・エラースキーマ等の共通仕様は [api-reference.md](../api-reference.md) を参照。
