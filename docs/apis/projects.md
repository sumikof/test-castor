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
| testcase_count | integer | 非archivedテストケース件数（スペック D-05） |
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
      "testcase_count": 42,
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

更新後のプロジェクト情報。フィールドは POST /api/v1/projects のレスポンスと同一構造（`id` / `name` / `repo_url` / `created_at` / `updated_at`）で、**`testcase_count` は含まない**（D-05: `testcase_count` は `GET /api/v1/projects` の一覧応答のみが返す追加フィールドで、POST/PATCH の単体レスポンスには含めない）。

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
