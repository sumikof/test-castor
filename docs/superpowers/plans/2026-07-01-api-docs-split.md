# API ドキュメント分割 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** モノリシックな `docs/api-reference.md` を索引+共通仕様に改修し、`docs/apis/` 配下に6つの個別APIドキュメントを作成する。

**Architecture:** 既存の `screens.md` → `screens/` パターンに倣い、`api-reference.md` を索引+共通仕様として残し、各APIグループの詳細仕様を `docs/apis/` 直下の個別ファイルに分離する。各ドキュメントはテーブルによる仕様定義+代表的なJSON例の併用形式とする。

**Tech Stack:** Markdown ドキュメントのみ（コード変更なし）

## Global Constraints

- ドキュメントの目的は「仕様を明確にする」こと。実装コードは記載しない
- フィールド定義はテーブルで網羅し、代表的なリクエスト/レスポンス例をJSONで1つずつ添える
- `api-reference.md` の共通仕様セクションは改修せずそのまま残す
- 情報の欠落がないこと（元の `api-reference.md` に記載されている全仕様が、改修後の索引+個別ドキュメントのいずれかに存在すること）
- `[※未実装]` マークなどの状態表記は元のまま維持する

---

### Task 1: `docs/apis/setup.md` — 初期セットアップAPI

**Files:**
- Create: `docs/apis/setup.md`

**Interfaces:**
- Consumes: `docs/api-reference.md` の「初期セットアップ」セクション（L146〜L194）
- Produces: `docs/apis/setup.md` — Task 7 の索引から参照される

- [ ] **Step 1: `docs/apis/` ディレクトリを作成**

```bash
mkdir -p docs/apis
```

- [ ] **Step 2: `docs/apis/setup.md` を作成**

以下の内容で作成する。

```markdown
# 初期セットアップ API

## 概要

初回デプロイ直後に組織と管理者アカウントを作成するAPI。Organization が0件のときのみ実行可能であり、認証不要で呼び出せる唯一のセットアップエンドポイント。

## エンドポイント一覧

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| POST | `/api/v1/setup` | 初回セットアップ | 不要 |

---

## POST /api/v1/setup

### 説明

初回デプロイ直後に組織と管理者アカウントを作成する。Organization テーブルが0件のときのみ実行可能。既にOrganizationが存在する場合は `409 SETUP_ALREADY_COMPLETE` を返す。

### 認証・認可

認証不要。Organization が未存在であることが前提条件となる。

### リクエスト仕様

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| organization_name | string | yes | 組織名 |
| admin_email | string | yes | 管理者メールアドレス |
| admin_password | string | yes | 管理者パスワード |
| admin_display_name | string | yes | 管理者の表示名 |

### リクエスト例

```json
{
  "organization_name": "株式会社Example",
  "admin_email": "admin@example.com",
  "admin_password": "secure-password-here",
  "admin_display_name": "管理太郎"
}
```

### レスポンス仕様

**201 Created**

| フィールド | 型 | 説明 |
|---|---|---|
| organization.id | string (UUID) | 作成された組織のID |
| organization.name | string | 組織名 |
| organization.created_at | integer (epoch ms) | 作成日時 |
| user.id | string (UUID) | 作成された管理者ユーザーのID |
| user.email | string | 管理者メールアドレス |
| user.display_name | string | 管理者の表示名 |
| user.role | string | 常に `"admin"` |
| user.created_at | integer (epoch ms) | 作成日時 |

### レスポンス例

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

### エラー

| エラーコード | HTTP | 条件 |
|---|---|---|
| `SETUP_ALREADY_COMPLETE` | 409 | Organization が既に存在する |
| `VALIDATION_FAILED` | 422 | 入力値バリデーションエラー |

### 業務ルール

- Organization が1件以上存在する場合、このエンドポイントは一切の操作を受け付けない
- 組織と管理者ユーザーは単一トランザクションで同時に作成される
- 作成された管理者は `admin` ロールを持つ

---

## 共通仕様

日時表現・エラースキーマ等の共通仕様は [api-reference.md](../api-reference.md) を参照。
```

- [ ] **Step 3: 内容を確認**

元の `api-reference.md` L146〜L194 の情報がすべて含まれていることを確認する。

- [ ] **Step 4: コミット**

```bash
git add docs/apis/setup.md
git commit -m "docs: 初期セットアップAPIの個別ドキュメントを作成"
```

---

### Task 2: `docs/apis/auth.md` — 認証API

**Files:**
- Create: `docs/apis/auth.md`

**Interfaces:**
- Consumes: `docs/api-reference.md` の「認証」セクション（L196〜L333）
- Produces: `docs/apis/auth.md` — Task 7 の索引から参照される

- [ ] **Step 1: `docs/apis/auth.md` を作成**

以下の内容で作成する。

```markdown
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
```

- [ ] **Step 2: 内容を確認**

元の `api-reference.md` L196〜L333 の情報がすべて含まれていることを確認する。

- [ ] **Step 3: コミット**

```bash
git add docs/apis/auth.md
git commit -m "docs: 認証APIの個別ドキュメントを作成"
```

---

### Task 3: `docs/apis/users.md` — ユーザー管理API

**Files:**
- Create: `docs/apis/users.md`

**Interfaces:**
- Consumes: `docs/api-reference.md` の「ユーザー管理」セクション（L335〜L462）
- Produces: `docs/apis/users.md` — Task 7 の索引から参照される

- [ ] **Step 1: `docs/apis/users.md` を作成**

以下の内容で作成する。

```markdown
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
| created_at | integer (epoch ms) | 作成日時 |
| updated_at | integer (epoch ms) | 更新日時 |

### レスポンス例

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
| created_at | integer (epoch ms) | 作成日時 |
| updated_at | integer (epoch ms) | 更新日時 |

### レスポンス例

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
  "created_at": 1719388800000,
  "updated_at": 1719392400000
}
```

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
```

- [ ] **Step 2: 内容を確認**

元の `api-reference.md` L335〜L462 の情報がすべて含まれていることを確認する。

- [ ] **Step 3: コミット**

```bash
git add docs/apis/users.md
git commit -m "docs: ユーザー管理APIの個別ドキュメントを作成"
```

---

### Task 4: `docs/apis/projects.md` — プロジェクトAPI

**Files:**
- Create: `docs/apis/projects.md`

**Interfaces:**
- Consumes: `docs/api-reference.md` の「プロジェクト」セクション（L464〜L538）
- Produces: `docs/apis/projects.md` — Task 7 の索引から参照される

- [ ] **Step 1: `docs/apis/projects.md` を作成**

以下の内容で作成する。

```markdown
# プロジェクト API

## 概要

テストケースを管理する単位であるプロジェクトの一覧取得・作成・更新を提供するAPI群。プロジェクトはテストケースやAPIトークンの親リソースとなる。

## エンドポイント一覧

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| GET | `/api/v1/projects` | プロジェクト一覧 | viewer |
| POST | `/api/v1/projects` | プロジェクト作成 | admin |
| PATCH | `/api/v1/projects/:pid` | プロジェクト更新 | admin |

---

## GET /api/v1/projects

### 説明

プロジェクト一覧を返す。

### 認証・認可

セッション Cookie。viewer 以上のロール。

### リクエスト仕様

なし。

### レスポンス仕様

**200 OK**

コレクション応答の統一構造（`{ items }` ラップ）で返す。

各アイテムのフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | プロジェクトID |
| name | string | プロジェクト名 |
| repo_url | string / null | 連携元リポジトリURL |
| created_at | integer (epoch ms) | 作成日時 |
| updated_at | integer (epoch ms) | 更新日時 |

### レスポンス例

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

---

## POST /api/v1/projects

### 説明

新規プロジェクトを作成する。

### 認証・認可

セッション Cookie。admin ロール必須。

### リクエスト仕様

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| name | string | yes | プロジェクト名 |
| repo_url | string | no | 連携元リポジトリURL |

### リクエスト例

```json
{
  "name": "payment-service",
  "repo_url": "https://github.com/example/payment"
}
```

### レスポンス仕様

**201 Created**

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | プロジェクトID |
| name | string | プロジェクト名 |
| repo_url | string / null | 連携元リポジトリURL |
| created_at | integer (epoch ms) | 作成日時 |
| updated_at | integer (epoch ms) | 更新日時 |

### レスポンス例

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

## PATCH /api/v1/projects/:pid

### 説明

プロジェクト情報を更新する。

### 認証・認可

セッション Cookie。admin ロール必須。

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| pid | string (UUID) | プロジェクトID |

### リクエスト仕様

PATCHセマンティクス（キー未指定=不変、明示的null=クリア）に従う。詳細は [api-reference.md](../api-reference.md#patch-セマンティクス) を参照。

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| name | string | no | プロジェクト名 |
| repo_url | string | no | 連携元リポジトリURL（`null` でクリア） |

### リクエスト例

```json
{
  "name": "payment-service-v2",
  "repo_url": "https://github.com/example/payment-v2"
}
```

### レスポンス仕様

**200 OK**

更新後のプロジェクト情報（GET /api/v1/projects のアイテムと同一構造）。

### レスポンス例

```json
{
  "id": "uuid",
  "name": "payment-service-v2",
  "repo_url": "https://github.com/example/payment-v2",
  "created_at": 1719388800000,
  "updated_at": 1719392400000
}
```

---

## 共通仕様

日時表現・エラースキーマ等の共通仕様は [api-reference.md](../api-reference.md) を参照。
```

- [ ] **Step 2: 内容を確認**

元の `api-reference.md` L464〜L538 の情報がすべて含まれていることを確認する。

- [ ] **Step 3: コミット**

```bash
git add docs/apis/projects.md
git commit -m "docs: プロジェクトAPIの個別ドキュメントを作成"
```

---

### Task 5: `docs/apis/testcases.md` — テストケースAPI

**Files:**
- Create: `docs/apis/testcases.md`

**Interfaces:**
- Consumes: `docs/api-reference.md` の「テストケース」セクション（L540〜L975）
- Produces: `docs/apis/testcases.md` — Task 7 の索引から参照される

- [ ] **Step 1: `docs/apis/testcases.md` を作成**

以下の内容で作成する。

```markdown
# テストケース API

## 概要

テストケースの CRUD、ステータス管理、衛星同期に関連する drift 解消・観測履歴・構造化Diff、および一括操作を提供するAPI群。すべてのエンドポイントはプロジェクトスコープ（`/projects/:pid/testcases`）配下に配置される。

## エンドポイント一覧

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

### 共通パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| pid | string (UUID) | プロジェクトID |
| id | string (UUID) | テストケースID（個別操作時） |

---

## GET /api/v1/projects/:pid/testcases

### 説明

テストケース一覧を返す。カーソルベースページングに対応する。

### 認証・認可

セッション Cookie または API トークン。viewer 以上のロール。

### クエリパラメータ

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

### レスポンス仕様

**200 OK**

カーソルベースページング対応のコレクション応答。ページングの詳細は [api-reference.md](../api-reference.md#カーソルベースページング) を参照。

各アイテムのフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | テストケースID |
| title | string | テストケース名 |
| target | string / null | 対象メソッド/クラス |
| category | string | `normal` / `abnormal` / `boundary` / `error_handling` |
| status | string | `draft` / `approved` / `archived` |
| ownership | string | `machine` / `human` |
| is_stale | boolean | stale フラグ |
| drift | boolean | drift フラグ |
| version | integer | OCC 用バージョン番号 |
| created_at | integer (epoch ms) | 作成日時 |
| updated_at | integer (epoch ms) | 更新日時 |

### レスポンス例

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

---

## POST /api/v1/projects/:pid/testcases

### 説明

手動でテストケースを作成する。`ownership=human`、`created_origin=manual` で作成される。

### 認証・認可

セッション Cookie。editor 以上のロール。

### リクエスト仕様

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

### リクエスト例

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

### レスポンス仕様

**201 Created**

作成されたテストケースの全フィールド（GET /api/v1/projects/:pid/testcases/:id と同一構造）。

### 業務ルール

- `ownership` は常に `human` に設定される（手動作成のため）
- `created_origin` は常に `manual` に設定される

---

## GET /api/v1/projects/:pid/testcases/:id

### 説明

テストケースの詳細を取得する。レスポンスヘッダに弱 ETag（OCC用）を含む。

### 認証・認可

セッション Cookie または API トークン。viewer 以上のロール。

### レスポンスヘッダ

| ヘッダ | 値 | 説明 |
|---|---|---|
| ETag | `W/"3"` | 弱 ETag。OCC の version 値を格納 |

### レスポンス仕様

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | テストケースID |
| title | string | テストケース名 |
| target | string / null | 対象メソッド/クラス |
| category | string | `normal` / `abnormal` / `boundary` / `error_handling` |
| given | string | 事前条件 |
| when | string | 操作 |
| then | string | 期待結果 |
| parameters | array / null | パラメータ化テストのデータセット |
| status | string | `draft` / `approved` / `archived` |
| is_stale | boolean | stale フラグ |
| ownership | string | `machine` / `human` |
| mirror_origin | string / null | ミラー元の衛星識別子 |
| drift | boolean | drift フラグ |
| fingerprint | string / null | canonical の指紋 |
| version | integer | OCC 用バージョン番号 |
| confidence | number / null | 信頼度（0.0〜1.0） |
| source_ref | object / null | 出所参照 |
| created_origin | string | 作成元（`discovery` / `manual` 等） |
| metadata | object / null | 任意メタデータ |
| created_at | integer (epoch ms) | 作成日時 |
| updated_at | integer (epoch ms) | 更新日時 |

### レスポンス例

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

---

## PATCH /api/v1/projects/:pid/testcases/:id

### 説明

テストケースを編集する。楽観的排他制御（OCC）による排他制御が必須。

### 認証・認可

セッション Cookie。editor 以上のロール。

### リクエストヘッダ（必須）

| ヘッダ | 値 | 説明 |
|---|---|---|
| If-Match | `"3"` | 更新対象の version 値。GET レスポンスの ETag から取得 |

### リクエスト仕様

PATCHセマンティクス（キー未指定=不変、明示的null=クリア）に従う。詳細は [api-reference.md](../api-reference.md#patch-セマンティクス) を参照。

更新可能なフィールドは POST /api/v1/projects/:pid/testcases のリクエスト仕様と同一（すべて任意）。

### リクエスト例

```json
{
  "title": "更新されたタイトル",
  "status": "approved"
}
```

### レスポンス仕様

**200 OK**

更新後のテストケース全フィールド + 新しい ETag（GET と同一構造）。

### エラー

| エラーコード | HTTP | 条件 |
|---|---|---|
| `OCC_CONFLICT` | 409 | version 不一致（他のユーザーが先に更新した） |
| `PRECONDITION_REQUIRED` | 428 | `If-Match` ヘッダ未指定 |

### 副作用・業務ルール

- `ownership=machine` のテストケースに対して人間所有列（title, target, category, given, when, then, parameters, status, confidence, metadata）の値が実際に変化する PATCH を行うと、`ownership` が `machine → human` に不可逆遷移する
- 同値・no-op PATCH では ownership 遷移は発生しない
- `version` は人間所有列の更新時のみインクリメントされる

OCC の詳細は [api-reference.md](../api-reference.md#楽観的排他制御occ) を参照。

---

## DELETE /api/v1/projects/:pid/testcases/:id

### 説明

テストケースをアーカイブする。物理削除は提供しない（`status=archived` に変更）。

### 認証・認可

セッション Cookie。editor 以上のロール。

### リクエスト仕様

なし。

### レスポンス仕様

**200 OK**

アーカイブ後のテストケース全フィールド。

### 業務ルール

- 物理削除を行わない理由: identity 消滅により、再同期で同じテストケースがゾンビとして復活するのを防ぐ
- `status` が `archived` に変更される

---

## GET /api/v1/projects/:pid/testcases/:id/history

### 説明

変更履歴を返す。カーソルベースページングに対応する。

### 認証・認可

セッション Cookie または API トークン。viewer 以上のロール。

### レスポンス仕様

**200 OK**

各アイテムのフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | 履歴エントリID |
| test_case_id | string (UUID) | テストケースID |
| actor | string | 型付き参照。`user:<id>` または `token:<id>` |
| action | string | `created` / `updated` / `status_changed` / `imported` |
| delta | object | 変更フィールドのみの差分 `{field: {before, after}}` |
| created_at | integer (epoch ms) | 変更日時 |

### レスポンス例

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

---

## GET /api/v1/projects/:pid/testcases/:id?format=gherkin

### 説明

テストケースを Gherkin/自然言語形式の派生ビューで返す。

### 認証・認可

セッション Cookie または API トークン。viewer 以上のロール。

### レスポンスヘッダ

| ヘッダ | 値 |
|---|---|
| Content-Type | `text/plain; charset=utf-8` |

### レスポンス仕様

**200 OK**

Gherkin 形式のプレーンテキスト。

### レスポンス例

```gherkin
Feature: 正常な支払い処理

  Scenario: 500円の支払いが成功する
    Given ユーザーの残高が十分にある
    When 500円の支払いを実行
    Then 支払いが成功し残高が500円減少する
```

---

## POST /api/v1/projects/:pid/testcases/:id/accept-fingerprint

### 説明

drift を解消する。最新 committed 観測の指紋を canonical に採用し、`drift=false` に更新する。OCC による排他制御が必須。

### 認証・認可

セッション Cookie。editor 以上のロール。

### リクエストヘッダ（必須）

| ヘッダ | 値 | 説明 |
|---|---|---|
| If-Match | `"3"` | 更新対象の version 値 |

### リクエスト仕様

ボディなし。

### レスポンス仕様

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | テストケースID |
| fingerprint | string | 更新後の canonical 指紋 |
| drift | boolean | 常に `false` |
| version | integer | インクリメントされた version |
| updated_at | integer (epoch ms) | 更新日時 |

### レスポンス例

```json
{
  "id": "uuid",
  "fingerprint": "sha256:new-fingerprint...",
  "drift": false,
  "version": 4,
  "updated_at": 1719392400000
}
```

### エラー

| エラーコード | HTTP | 条件 |
|---|---|---|
| `OCC_CONFLICT` | 409 | version 不一致 |
| `NO_DRIFT` | 422 | drift が発生していないテストケースに対する実行 |
| `PRECONDITION_REQUIRED` | 428 | `If-Match` ヘッダ未指定 |

### 副作用・業務ルール

処理の流れ:

1. 最新 committed 観測（`mirror_origin` 由来）の指紋を取得する
2. canonical の `fingerprint` を観測の指紋で更新する
3. `drift = false` に設定する
4. `version` を +1 する（人間所有列の明示的操作のため）
5. TestCaseHistory に `status_changed` として記録する

---

## GET /api/v1/projects/:pid/testcases/:id/identities

### 説明

テストケースに紐づく per-origin の同定情報を返す。構造化 Diff や stale 状態のドリルダウン表示に使用する。

### 認証・認可

セッション Cookie または API トークン。viewer 以上のロール。

### レスポンス仕様

**200 OK**

各アイテムのフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | Identity ID |
| origin | string | 観測元の衛星識別子 |
| external_ref | string | 当該オリジンの参照 ID |
| is_stale | boolean | per-origin の stale 状態（true = 直近の同期で未出現） |
| last_seen_at | integer (epoch ms) | 直近の出現確認時刻 |
| created_at | integer (epoch ms) | 作成日時 |

### レスポンス例

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

---

## GET /api/v1/projects/:pid/testcases/:id/observations

### 説明

テストケースの committed 観測を時系列で返す。カーソルベースページングに対応する。committed セッション由来の観測のみを対象とする（active/expired セッション由来の観測は除外）。

### 認証・認可

セッション Cookie または API トークン。viewer 以上のロール。

### クエリパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| origin | string | 特定 origin でフィルタ（任意） |
| cursor | string | ページングカーソル |
| limit | integer | 1ページあたりの件数 |

### レスポンス仕様

**200 OK**

各アイテムのフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | 観測ID |
| origin | string | 観測元の衛星識別子 |
| fingerprint | string | 観測の指紋 |
| observed | object | 観測内容（下記参照） |
| created_at | integer (epoch ms) | 観測日時 |

`observed` オブジェクトのフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| given | string | 事前条件 |
| when | string | 操作 |
| then | string | 期待結果 |
| parameters | array | パラメータ |
| source_ref | object | 出所参照 |
| schema_version | string | スキーマバージョン |

### レスポンス例

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

---

## GET /api/v1/projects/:pid/testcases/:id/diff

### 説明

canonical（現在のテスト仕様）と最新 committed 観測の構造化差分を返す。drift が発生しているテストケースの差分確認に使用する。

### 認証・認可

セッション Cookie または API トークン。viewer 以上のロール。

### レスポンス仕様

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| has_drift | boolean | drift 発生中なら `true` |
| origin | string / null | 最新観測の origin（drift 未発生時は `null`） |
| observed_at | integer (epoch ms) / null | 最新観測の時刻（drift 未発生時は `null`） |
| canonical | object | 現在のテスト仕様（given/when/then/parameters） |
| latest_observation | object / null | 最新 committed 観測の内容（drift 未発生時は `null`） |
| diff | object / null | 差分があるフィールドのみの before/after（drift 未発生時は `null`） |

`diff` オブジェクトの各フィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| {field}.before | string | canonical 側の値 |
| {field}.after | string | 最新観測側の値 |

差分なしのフィールドは `diff` に含まれない。

### レスポンス例（drift あり）

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

### レスポンス例（drift なし）

```json
{
  "has_drift": false,
  "origin": null,
  "observed_at": null,
  "canonical": {
    "given": "カート内に商品が1点ある",
    "when": "注文確定ボタンを押す",
    "then": "合計金額が表示される",
    "parameters": null
  },
  "latest_observation": null,
  "diff": null
}
```

---

## POST /api/v1/projects/:pid/testcases/bulk

### 説明

複数のテストケースに対して一括でステータス変更を実行する。

### 認証・認可

セッション Cookie。editor 以上のロール。

### リクエスト仕様

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| ids | string[] | yes | 対象テストケースの ID 配列（最大 100 件） |
| action | enum | yes | `approve` / `archive` / `restore` |

### リクエスト例

```json
{
  "ids": ["uuid-1", "uuid-2", "uuid-3"],
  "action": "approve"
}
```

### レスポンス仕様

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| updated | integer | 正常に更新されたテストケース数 |
| skipped | integer | 既に対象ステータスのためスキップされた件数 |
| errors | array | 個別のエラー（OCC 競合等） |

`errors` 配列の各要素:

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | エラーが発生したテストケースID |
| code | string | エラーコード |
| message | string | エラーメッセージ |

### レスポンス例

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

### 副作用・業務ルール

**`approve` アクション:**

- `status` を `approved` に変更する
- `ownership=machine` のテストケースは `human` に不可逆遷移する
- 各テストケースに個別の TestCaseHistory エントリを記録する
- `archived` のテストケースには `approve` を実行できない（`restore` で `draft` に復帰してから承認する）

**`archive` アクション:**

- `status` を `archived` に変更する
- 各テストケースに個別の TestCaseHistory エントリを記録する

**`restore` アクション:**

- `archived` のテストケースを `draft` に復帰する
- `archived` 以外のテストケースはスキップされる
- 各テストケースに個別の TestCaseHistory エントリを記録する

**制約:**

- 1 リクエストあたり最大 100 件
- OCC は使用しない（一括操作の利便性を優先）。個別の競合はベストエフォートで処理し、`errors` で報告する

---

## 共通仕様

以下の共通仕様はテストケースAPIに深く関わるため、必要に応じて参照すること。

- [楽観的排他制御（OCC）](../api-reference.md#楽観的排他制御occ) — PATCH / accept-fingerprint で必須
- [PATCH セマンティクス](../api-reference.md#patch-セマンティクス) — フィールドの更新・不変・クリアの区別
- [カーソルベースページング](../api-reference.md#カーソルベースページング) — 一覧・履歴・観測で使用
```

- [ ] **Step 2: 内容を確認**

元の `api-reference.md` L540〜L975 の情報がすべて含まれていることを確認する。特に以下を重点確認:
- 12エンドポイントすべてが記載されている
- ownership 遷移ルール（PATCH）
- accept-fingerprint の処理フロー（5ステップ）
- bulk の3アクションの業務ルール
- diff の drift あり/なし両方のレスポンス仕様

- [ ] **Step 3: コミット**

```bash
git add docs/apis/testcases.md
git commit -m "docs: テストケースAPIの個別ドキュメントを作成"
```

---

### Task 6: `docs/apis/tokens.md` — APIトークン管理API

**Files:**
- Create: `docs/apis/tokens.md`

**Interfaces:**
- Consumes: `docs/api-reference.md` の「API トークン管理」セクション（L977〜L1045）
- Produces: `docs/apis/tokens.md` — Task 7 の索引から参照される

- [ ] **Step 1: `docs/apis/tokens.md` を作成**

以下の内容で作成する。

```markdown
# API トークン管理 API

## 概要

衛星サービスがTMS APIにアクセスするためのAPIトークンの発行・一覧取得・失効を提供するAPI群。トークンはプロジェクトスコープで管理される。

## エンドポイント一覧

| メソッド | パス | 用途 | 最低 role |
|---|---|---|---|
| POST | `/api/v1/projects/:pid/tokens` | トークン発行 | admin |
| GET | `/api/v1/projects/:pid/tokens` | トークン一覧 | admin |
| DELETE | `/api/v1/projects/:pid/tokens/:id` | トークン失効 | admin |

### 共通パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| pid | string (UUID) | プロジェクトID |
| id | string (UUID) | トークンID（個別操作時） |

---

## POST /api/v1/projects/:pid/tokens

### 説明

APIトークンを発行する。平文トークンはこのレスポンスでのみ1回だけ返され、以後は取得不可。

### 認証・認可

セッション Cookie。admin ロール必須。

### リクエスト仕様

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| name | string | yes | トークンの識別名 |

### リクエスト例

```json
{
  "name": "discovery-satellite-prod"
}
```

### レスポンスヘッダ

| ヘッダ | 値 | 説明 |
|---|---|---|
| Cache-Control | `no-store` | トークンのキャッシュを禁止 |

### レスポンス仕様

**201 Created**

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | トークンID |
| name | string | トークンの識別名 |
| token | string | 平文トークン（この応答でのみ返される） |
| created_at | integer (epoch ms) | 作成日時 |

### レスポンス例

```json
{
  "id": "uuid",
  "name": "discovery-satellite-prod",
  "token": "tms_base64url-encoded-32bytes-or-more",
  "created_at": 1719388800000
}
```

### 業務ルール

- `token` フィールドは発行レスポンスのみに含まれる
- ログ・履歴・エラーボディには平文トークンを一切含めない
- トークンはサーバー側ではハッシュ化して保存される

---

## GET /api/v1/projects/:pid/tokens

### 説明

発行済みトークンの一覧を返す。平文・ハッシュは返さない。

### 認証・認可

セッション Cookie。admin ロール必須。

### リクエスト仕様

なし。

### レスポンス仕様

**200 OK**

各アイテムのフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | トークンID |
| name | string | トークンの識別名 |
| created_at | integer (epoch ms) | 作成日時 |
| revoked_at | integer (epoch ms) / null | 失効日時（未失効なら `null`） |
| last_used_at | integer (epoch ms) / null | 最終使用日時（未使用なら `null`） |

### レスポンス例

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

---

## DELETE /api/v1/projects/:pid/tokens/:id

### 説明

トークンをソフト失効させる（`revoked_at` を記録）。失効済みトークンでの認証は即座に `401` となる。

### 認証・認可

セッション Cookie。admin ロール必須。

### リクエスト仕様

なし。

### レスポンス仕様

**200 OK**

| フィールド | 型 | 説明 |
|---|---|---|
| id | string (UUID) | トークンID |
| name | string | トークンの識別名 |
| revoked_at | integer (epoch ms) | 失効日時 |

### レスポンス例

```json
{
  "id": "uuid",
  "name": "discovery-satellite-prod",
  "revoked_at": 1719460000000
}
```

### 業務ルール

- 物理削除ではなくソフト失効（`revoked_at` に現在時刻を記録）
- 失効後のトークンで API を呼び出すと即座に `401 UNAUTHORIZED` が返される
- 失効操作は冪等（既に失効済みのトークンに対しても正常応答）

---

## 共通仕様

日時表現・エラースキーマ等の共通仕様は [api-reference.md](../api-reference.md) を参照。
```

- [ ] **Step 2: 内容を確認**

元の `api-reference.md` L977〜L1045 の情報がすべて含まれていることを確認する。

- [ ] **Step 3: コミット**

```bash
git add docs/apis/tokens.md
git commit -m "docs: APIトークン管理APIの個別ドキュメントを作成"
```

---

### Task 7: `api-reference.md` を索引+共通仕様に改修

**Files:**
- Modify: `docs/api-reference.md`

**Interfaces:**
- Consumes: Task 1〜6 で作成した全 `docs/apis/*.md` ファイル
- Produces: 改修済みの `docs/api-reference.md`（索引+共通仕様）

- [ ] **Step 1: `api-reference.md` を改修**

以下の方針で改修する:

1. **L1〜L140（共通仕様）はそのまま維持**:
   - 「このドキュメントについて」
   - 「共通仕様」（ベースパス〜バージョニング規約）
   - 「統一エラースキーマ」
   - 「楽観的排他制御（OCC）」
   - 「PATCH セマンティクス」

2. **L142〜L975（エンドポイント詳細）を索引に置換**:

「エンドポイント一覧」セクションを以下のように書き換える:

```markdown
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
```

3. **L1047〜L1085（冪等性・origin正規化・関連ドキュメント）はそのまま維持**

- [ ] **Step 2: 改修結果を確認**

改修後の `api-reference.md` が以下の構成になっていることを確認する:
- 共通仕様セクションが完全に残っている（L1〜L140 相当）
- エンドポイント一覧が索引形式（テーブル + リンク）になっている
- 個別エンドポイントの詳細（リクエスト/レスポンス/エラー/副作用）がすべて除去されている
- 冪等性・origin正規化・関連ドキュメントが残っている
- 全リンクのパスが正しい（`./apis/setup.md` 等の相対パス）

- [ ] **Step 3: コミット**

```bash
git add docs/api-reference.md
git commit -m "docs: api-reference.mdを索引+共通仕様に改修し個別ドキュメントへ参照"
```

---

### Task 8: 情報欠落チェック

**Files:**
- Read: `docs/api-reference.md`（改修後）
- Read: `docs/apis/*.md`（全6ファイル）

**Interfaces:**
- Consumes: Task 1〜7 の成果物すべて

- [ ] **Step 1: 元の `api-reference.md` のエンドポイント数を確認**

元のドキュメントに記載されていた全29エンドポイントが個別ドキュメントに移行されているか確認する:

| グループ | エンドポイント数 | ファイル |
|---|---|---|
| 初期セットアップ | 1 | setup.md |
| 認証 | 5 | auth.md |
| ユーザー管理 | 5 | users.md |
| プロジェクト | 3 | projects.md |
| テストケース | 12 | testcases.md |
| API トークン管理 | 3 | tokens.md |
| **合計** | **29** | |

- [ ] **Step 2: 共通仕様の残留確認**

`api-reference.md` に以下の共通仕様セクションが残っていることを確認する:
- ベースパス
- リソース階層化（IDOR 防止）
- 日時表現
- コレクション応答の統一構造
- カーソルベースページング
- バージョニング規約
- 統一エラースキーマ（安定エラーコード10種）
- 楽観的排他制御（OCC）
- PATCH セマンティクス
- 冪等性（Idempotency-Key）
- origin 正規化規約

- [ ] **Step 3: リンク整合性の確認**

各ファイルのリンクが正しく解決されるか確認する:
- `api-reference.md` → `./apis/setup.md` 等（6リンク）
- 各 `apis/*.md` → `../api-reference.md`（共通仕様への参照）
- `api-reference.md` → `./sync-protocol.md`, `./auth-security.md` 等（関連ドキュメント）

- [ ] **Step 4: 最終コミット（必要な場合）**

不備が見つかった場合は修正してコミットする。不備がなければこのステップはスキップ。
