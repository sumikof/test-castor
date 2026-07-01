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
