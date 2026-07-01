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
