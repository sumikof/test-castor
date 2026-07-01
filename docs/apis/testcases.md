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
