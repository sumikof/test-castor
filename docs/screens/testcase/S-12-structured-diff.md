# S-12 構造化 Diff ビュー

| 項目 | 値 |
|---|---|
| **画面 ID** | S-12 |
| **画面名** | 構造化 Diff ビュー |
| **種別** | タブ（S-10 テストケース詳細内） |
| **URL** | `/projects/:pid/testcases/:id#diff` |
| **対応 UC** | UC-15 |
| **最低ロール** | viewer（閲覧）/ editor（accept-fingerprint 操作） |

---

## 目的

drift が発生したテストケースについて、canonical（現在のテスト仕様）と最新 committed 観測の差分をフィールド単位で構造化表示する。差分を確認した上で accept-fingerprint 操作で drift を解消する。

---

## ワイヤーフレーム

```
┌──────────────────────────────────────────────────────────┐
│ [基本情報] [Gherkin] [構造化Diff ●] [変更履歴]           │
│ ─────────────────────────────────────────────────────    │
│                                                          │
│ canonical（現在の仕様）  ←→  最新の観測                  │
│ origin: discovery-ci  観測日時: 2026-06-28 13:15         │
│                                                          │
│ Given:                                                   │
│ - カート内に商品が1点ある                                │
│ + カート内に商品が1点以上ある                             │
│                                                          │
│ When:                                                    │
│   （変更なし）                                           │
│                                                          │
│ Then:                                                    │
│ - 合計金額が表示される                                   │
│ + 合計金額と送料が表示される                             │
│                                                          │
│ Parameters:                                              │
│   （変更なし）                                           │
│                                                          │
│ [accept-fingerprint: この観測を正として受け入れる]        │
└──────────────────────────────────────────────────────────┘
```

---

## 要素カタログ

### タブバー

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| 基本情報タブ | tab | `tab-basic-info` | S-10 基本情報へ切替 | 常時表示 |
| Gherkin タブ | tab | `tab-gherkin` | S-13 Gherkin ビューへ切替 | 常時表示 |
| 構造化 Diff タブ | tab (active) | `tab-diff` | 現在のタブ。drift 時にバッジ `●` 付き | 常時表示。drift 未発生時は disabled / グレーアウト |
| 変更履歴タブ | tab | `tab-history` | S-14 変更履歴へ切替 | 常時表示 |
| Identity 情報タブ | tab | `tab-identities` | Identity 情報へ切替 | 常時表示 |

### Diff ヘッダー

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| Diff ヘッダーラベル | text | `diff-header` | 「canonical（現在の仕様） ←→ 最新の観測」 | drift=true 時のみ表示 |
| Origin 表示 | text | `diff-origin` | 最新観測の origin 名（例: `discovery-ci`） | drift=true 時のみ表示 |
| 観測日時表示 | text | `diff-observed-at` | 最新観測の日時（epoch ms → ローカル表示） | drift=true 時のみ表示 |

### Diff コンテンツ

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| Given Diff セクション | diff-block | `diff-section-given` | Given フィールドの差分表示 | drift=true 時のみ |
| When Diff セクション | diff-block | `diff-section-when` | When フィールドの差分表示 | drift=true 時のみ |
| Then Diff セクション | diff-block | `diff-section-then` | Then フィールドの差分表示 | drift=true 時のみ |
| Parameters Diff セクション | diff-block | `diff-section-parameters` | Parameters フィールドの差分表示 | drift=true 時のみ |
| 削除行（canonical 側） | text (styled) | `diff-line-removed` | `-` プレフィックス + 赤背景 | 該当フィールドに差分がある場合 |
| 追加行（観測側） | text (styled) | `diff-line-added` | `+` プレフィックス + 緑背景 | 該当フィールドに差分がある場合 |
| 変更なしラベル | text | `diff-no-change` | 「（変更なし）」 | 該当フィールドに差分がない場合 |

### Diff 不在時（drift=false）

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| Drift 未発生メッセージ | text | `diff-no-drift` | 「現在 drift は発生していません。canonical のみ表示します。」 | drift=false 時 |
| Canonical 表示（Given） | text | `canonical-given` | 現在の Given テキスト | drift=false 時 |
| Canonical 表示（When） | text | `canonical-when` | 現在の When テキスト | drift=false 時 |
| Canonical 表示（Then） | text | `canonical-then` | 現在の Then テキスト | drift=false 時 |
| Canonical 表示（Parameters） | text | `canonical-parameters` | 現在の Parameters 表示 | drift=false 時 |

### アクション

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| Accept Fingerprint ボタン | button | `btn-accept-fingerprint` | 最新観測の指紋を canonical に採用して drift を解消する | drift=true かつ editor 以上。viewer には非表示 |

---

## 状態バリエーション

| 状態 | 表示内容 |
|---|---|
| **drift=true** | Diff ヘッダー + 全フィールドの差分表示 + Accept Fingerprint ボタン |
| **drift=false** | Diff 未発生メッセージ + canonical のみ表示。Accept Fingerprint ボタン非表示 |
| **viewer ロール** | 差分は閲覧可能だが Accept Fingerprint ボタンは非表示 |
| **editor/admin ロール** | 差分閲覧 + Accept Fingerprint ボタン表示 |
| **タブ disabled** | drift=false 時、タブは選択可能だがバッジ `●` なし。クリック時は canonical のみ表示 |

---

## API 呼び出し

| トリガー | メソッド | パス | 説明 |
|---|---|---|---|
| タブ選択時 | GET | `/api/v1/projects/:pid/testcases/:id/diff` | Diff データ取得 |
| Accept Fingerprint クリック時 | POST | `/api/v1/projects/:pid/testcases/:id/accept-fingerprint` | drift 解消 |

### GET /api/v1/projects/:pid/testcases/:id/diff

**レスポンス（drift あり）:**
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

**レスポンス（drift なし）:**
```json
{
  "has_drift": false,
  "origin": null,
  "observed_at": null,
  "canonical": { "given": "...", "when": "...", "then": "...", "parameters": null },
  "latest_observation": null,
  "diff": null
}
```

### POST /api/v1/projects/:pid/testcases/:id/accept-fingerprint

**リクエストヘッダ:**
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

---

## 画面遷移

| 操作 | 遷移先 |
|---|---|
| 基本情報タブクリック | S-10 基本情報 |
| Gherkin タブクリック | S-13 Gherkin ビュー |
| 変更履歴タブクリック | S-14 変更履歴 |
| Identity 情報タブクリック | S-10 Identity 情報 |
| Accept Fingerprint 成功 | 同一タブ（drift=false 状態に遷移） |

---

## エラー状態

| エラー | HTTP | code | UI 表示 |
|---|---|---|---|
| OCC 競合 | 409 | `OCC_CONFLICT` | トースト：「他のユーザーが先に更新しました。最新の内容を確認してください。」+ 再読み込みボタン |
| Drift 未発生 | 422 | `NO_DRIFT` | トースト：「このテストケースには drift が発生していません。」 |
| If-Match 未指定 | 428 | `PRECONDITION_REQUIRED` | トースト：「更新に必要な情報が不足しています。画面を再読み込みしてください。」 |
| 認証エラー | 401 | `UNAUTHORIZED` | ログイン画面にリダイレクト |
| リソース不在 | 404 | `NOT_FOUND` | 「テストケースが見つかりません。」 |

---

## トースト・通知

| 操作 | 結果 | メッセージ |
|---|---|---|
| Accept Fingerprint 成功 | success | 「drift を解消しました。」 |
| Accept Fingerprint 失敗（OCC） | error | 「他のユーザーが先に更新しました。最新の内容を確認してください。」 |
| Accept Fingerprint 失敗（NO_DRIFT） | warning | 「このテストケースには drift が発生していません。」 |
