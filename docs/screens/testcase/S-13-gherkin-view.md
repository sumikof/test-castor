# S-13 Gherkin ビュー

| 項目 | 値 |
|---|---|
| **画面 ID** | S-13 |
| **画面名** | Gherkin ビュー |
| **種別** | タブ（S-10 テストケース詳細内） |
| **URL** | `/projects/:pid/testcases/:id#gherkin` |
| **対応 UC** | UC-20 |
| **最低ロール** | viewer |

---

## 目的

テストケースを Gherkin（BDD）形式で整形表示する。テスト仕様書としてステークホルダーに共有する場面で使用する。パラメータ化テストの場合は Scenario Outline + Examples テーブルとして表示する。

---

## ワイヤーフレーム

```
┌──────────────────────────────────────────────────────────┐
│ [基本情報] [Gherkin ●] [構造化Diff] [変更履歴]           │
│ ─────────────────────────────────────────────────────    │
│                                                          │
│ Feature: 決済処理                                        │
│                                                          │
│   Scenario: 有効期限切れカードで決済を試みると           │
│             エラーが返る                                 │
│     Given 有効期限が過去のカード情報が登録されている      │
│     When そのカードで 1,000 円の決済を実行する            │
│     Then 決済が拒否され、エラーコード                    │
│          CARD_EXPIRED が返る                              │
│                                                          │
│                         [クリップボードにコピー]         │
│                         [エクスポート]                    │
└──────────────────────────────────────────────────────────┘
```

### パラメータ化テスト時

```
┌──────────────────────────────────────────────────────────┐
│ [基本情報] [Gherkin ●] [構造化Diff] [変更履歴]           │
│ ─────────────────────────────────────────────────────    │
│                                                          │
│ Feature: 年齢バリデーション                              │
│                                                          │
│   Scenario Outline: 年齢フィールドのバリデーション       │
│     Given ユーザー登録フォームが表示されている            │
│     When 年齢フィールドに <age> を入力して送信する        │
│     Then <expected> が返る                               │
│                                                          │
│     Examples:                                            │
│       | name     | age  | expected                       │
│       | 負の値   | -1   | エラー「0以上を入力して...」    │
│       | 下限境界 | 0    | 成功                           │
│       | 上限境界 | 150  | 成功                           │
│       | 上限超過 | 151  | エラー「150以下を入力して...」  │
│                                                          │
│                         [クリップボードにコピー]         │
│                         [エクスポート]                    │
└──────────────────────────────────────────────────────────┘
```

---

## 要素カタログ

### タブバー

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| 基本情報タブ | tab | `tab-basic-info` | S-10 基本情報へ切替 | 常時表示 |
| Gherkin タブ | tab (active) | `tab-gherkin` | 現在のタブ。選択中にバッジ `●` 付き | 常時表示 |
| 構造化 Diff タブ | tab | `tab-diff` | S-12 構造化 Diff へ切替 | 常時表示 |
| 変更履歴タブ | tab | `tab-history` | S-14 変更履歴へ切替 | 常時表示 |
| Identity 情報タブ | tab | `tab-identities` | Identity 情報へ切替 | 常時表示 |

### Gherkin コンテンツ

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| Gherkin テキストブロック | pre / code | `gherkin-content` | Gherkin 形式で整形されたテストケース全文。シンタックスハイライト付き | 常時表示 |
| Feature 行 | text | `gherkin-feature` | `Feature: <target or title>` | 常時表示 |
| Scenario 行 | text | `gherkin-scenario` | `Scenario: <title>` （パラメータなし時） | parameters が null/空 |
| Scenario Outline 行 | text | `gherkin-scenario-outline` | `Scenario Outline: <title>` （パラメータあり時） | parameters が 1 件以上 |
| Given 行 | text | `gherkin-given` | `Given <given>` | 常時表示 |
| When 行 | text | `gherkin-when` | `When <when>` | 常時表示 |
| Then 行 | text | `gherkin-then` | `Then <then>` | 常時表示 |
| Examples テーブル | table | `gherkin-examples` | パラメータの name / inputs / expected を表形式で表示 | parameters が 1 件以上 |

### アクションボタン

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| クリップボードにコピー | button | `btn-copy-gherkin` | Gherkin テキストをクリップボードにコピー | 常時表示 |
| エクスポート | button | `btn-export-gherkin` | `.feature` ファイルとしてダウンロード | `[※]` MVP 後。MVP では非表示または disabled |

---

## 状態バリエーション

| 状態 | 表示内容 |
|---|---|
| **パラメータなし** | `Scenario:` 形式。Given/When/Then のみ |
| **パラメータあり** | `Scenario Outline:` 形式。Given/When/Then + `Examples:` テーブル |
| **target あり** | `Feature:` に target（クラス名等）を使用 |
| **target なし** | `Feature:` にタイトルまたは汎用ラベルを使用 |
| **コピー成功後** | コピーボタンのアイコン/テキストが一時的に「コピーしました ✓」に変化（2-3秒後に戻る） |

---

## API 呼び出し

| トリガー | メソッド | パス | 説明 |
|---|---|---|---|
| タブ選択時 | GET | `/api/v1/projects/:pid/testcases/:id?format=gherkin` | Gherkin 形式のテキスト取得 |

### GET /api/v1/projects/:pid/testcases/:id?format=gherkin

**レスポンスヘッダ:**
```
Content-Type: text/plain; charset=utf-8
```

**レスポンス 200（パラメータなし）:**
```gherkin
Feature: 決済処理

  Scenario: 有効期限切れカードで決済を試みるとエラーが返る
    Given 有効期限が過去のカード情報が登録されている
    When そのカードで 1,000 円の決済を実行する
    Then 決済が拒否され、エラーコード CARD_EXPIRED が返る
```

**レスポンス 200（パラメータあり）:**
```gherkin
Feature: 年齢バリデーション

  Scenario Outline: 年齢フィールドのバリデーション
    Given ユーザー登録フォームが表示されている
    When 年齢フィールドに <age> を入力して送信する
    Then <expected> が返る

    Examples:
      | name     | age  | expected                       |
      | 負の値   | -1   | エラー「0以上を入力してください」 |
      | 下限境界 | 0    | 成功                           |
      | 上限境界 | 150  | 成功                           |
      | 上限超過 | 151  | エラー「150以下を入力してください」 |
```

---

## 画面遷移

| 操作 | 遷移先 |
|---|---|
| 基本情報タブクリック | S-10 基本情報 |
| 構造化 Diff タブクリック | S-12 構造化 Diff ビュー |
| 変更履歴タブクリック | S-14 変更履歴 |
| Identity 情報タブクリック | S-10 Identity 情報 |
| コピーボタンクリック | 遷移なし（クリップボード操作） |
| エクスポートボタンクリック | 遷移なし（ファイルダウンロード） |

---

## エラー状態

| エラー | HTTP | code | UI 表示 |
|---|---|---|---|
| 認証エラー | 401 | `UNAUTHORIZED` | ログイン画面にリダイレクト |
| リソース不在 | 404 | `NOT_FOUND` | 「テストケースが見つかりません。」 |
| サーバーエラー | 500 | — | 「Gherkin ビューの取得に失敗しました。再読み込みしてください。」 |

---

## トースト・通知

| 操作 | 結果 | メッセージ |
|---|---|---|
| コピー成功 | success | 「クリップボードにコピーしました。」 |
| コピー失敗 | error | 「コピーに失敗しました。手動でテキストを選択してコピーしてください。」 |
| エクスポート成功 | success | 「<filename>.feature をダウンロードしました。」 |
