# S-14 変更履歴

| 項目 | 値 |
|---|---|
| **画面 ID** | S-14 |
| **画面名** | 変更履歴 |
| **種別** | タブ（S-10 テストケース詳細内） |
| **URL** | `/projects/:pid/testcases/:id#history` |
| **対応 UC** | UC-21 |
| **最低ロール** | viewer |

---

## 目的

テストケースの変更経緯を時系列（新しい順）で確認する。「誰がいつ何を変えたか」を追跡し、承認・編集・取り込みの履歴を提供する。

---

## ワイヤーフレーム

```
┌──────────────────────────────────────────────────────────┐
│ [基本情報] [Gherkin] [構造化Diff] [変更履歴 ●]           │
│ ─────────────────────────────────────────────────────    │
│                                                          │
│ 2026-06-28 14:30  田中太郎  ステータス変更                │
│   status: draft → approved                               │
│                                                          │
│ 2026-06-28 14:25  田中太郎  更新                          │
│   then: "エラーが返る"                                   │
│       → "エラーコード CARD_EXPIRED が返る"               │
│   category: normal → abnormal                            │
│                                                          │
│ 2026-06-28 10:00  token:discovery-ci  取り込み           │
│   (初回取り込み)                                         │
│                                                          │
│                        [もっと見る]                       │
└──────────────────────────────────────────────────────────┘
```

---

## 要素カタログ

### タブバー

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| 基本情報タブ | tab | `tab-basic-info` | S-10 基本情報へ切替 | 常時表示 |
| Gherkin タブ | tab | `tab-gherkin` | S-13 Gherkin ビューへ切替 | 常時表示 |
| 構造化 Diff タブ | tab | `tab-diff` | S-12 構造化 Diff へ切替 | 常時表示 |
| 変更履歴タブ | tab (active) | `tab-history` | 現在のタブ。選択中にバッジ `●` 付き | 常時表示 |
| Identity 情報タブ | tab | `tab-identities` | Identity 情報へ切替 | 常時表示 |

### 履歴エントリ

各変更エントリは以下の要素で構成される。リスト全体は `data-testid="history-list"` を持つコンテナに格納する。

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| 履歴エントリコンテナ | div | `history-entry` | 1件の変更履歴。複数存在。各エントリに `data-history-id` 属性で ID を付与 | 常時表示 |
| 日時 | text | `history-datetime` | 変更日時。epoch ms → ローカル日時表示（例: `2026-06-28 14:30`） | 常時表示 |
| 実行者名 | text | `history-actor` | ユーザー表示名 + ロール、またはトークン名 | 常時表示 |
| 実行者アイコン | icon | `history-actor-icon` | ユーザー: 人アイコン / トークン: ロボットアイコン | 常時表示 |
| 操作種別ラベル | badge | `history-action` | `created` / `updated` / `status_changed` / `imported` の日本語ラベル | 常時表示 |
| 差分ブロック | div | `history-delta` | 変更フィールドの before/after 表示 | `created` / `imported`（初回）以外 |
| 差分フィールド名 | text | `history-delta-field` | 変更されたフィールド名（例: `status`, `then`, `category`） | 差分がある場合 |
| 差分 Before 値 | text (styled) | `history-delta-before` | 変更前の値。取り消し線またはハイライト付き | 差分がある場合 |
| 差分 After 値 | text (styled) | `history-delta-after` | 変更後の値。ハイライト付き | 差分がある場合 |
| 初回取り込みラベル | text | `history-initial-import` | 「（初回取り込み）」 | action=`imported` かつ初回の場合 |

### 操作種別の表示ラベル

| action 値 | 日本語ラベル | 説明 |
|---|---|---|
| `created` | 作成 | 手動作成 |
| `updated` | 更新 | フィールド編集 |
| `status_changed` | ステータス変更 | draft ↔ approved ↔ archived |
| `imported` | 取り込み | 衛星サービスからの同期取り込み |

### 実行者の表示ルール

| actor 値パターン | 表示 | 例 |
|---|---|---|
| `user:<uuid>` | ユーザー表示名 + ロールバッジ | `田中太郎 (editor)` |
| `token:<uuid>` | `token:` + トークン名 | `token:discovery-ci` |

**実装済みの制約:** `GET /testcases/:id/history` の `actor_display`（D-04）は表示名のみを解決し、ロール情報を含まない（`listHistory` が `users.display_name` を JOIN するのみで、role 列までは結合しないデータ制約。MVP として受容）。そのため本実装は user actor を**表示名のみ**（例: `田中太郎`）で表示し、ロールバッジは付与しない。

### ページング

| 要素 | 型 | data-testid | 説明 | 条件 |
|---|---|---|---|---|
| もっと見るボタン | button | `btn-load-more-history` | 次ページの履歴を読み込み（カーソルページング） | `has_more=true` の場合のみ表示 |
| ローディングスピナー | spinner | `history-loading` | 追加読み込み中のインジケーター | API 呼び出し中 |
| 履歴なしメッセージ | text | `history-empty` | 「変更履歴はありません。」 | items が空の場合 |

---

## 状態バリエーション

| 状態 | 表示内容 |
|---|---|
| **履歴あり・続きあり** | 履歴エントリ一覧 + 「もっと見る」ボタン |
| **履歴あり・末尾** | 履歴エントリ一覧のみ。「もっと見る」ボタン非表示 |
| **履歴なし** | 「変更履歴はありません。」メッセージ |
| **読み込み中** | ローディングスピナー表示 |
| **追加読み込み中** | 既存エントリの下にスピナー表示 |

---

## API 呼び出し

| トリガー | メソッド | パス | 説明 |
|---|---|---|---|
| タブ選択時 | GET | `/api/v1/projects/:pid/testcases/:id/history` | 初回履歴取得 |
| 「もっと見る」クリック時 | GET | `/api/v1/projects/:pid/testcases/:id/history?cursor=...` | 次ページ取得 |

### GET /api/v1/projects/:pid/testcases/:id/history

**クエリパラメータ:**

| パラメータ | 型 | 説明 |
|---|---|---|
| cursor | string | ページングカーソル（省略時は先頭から） |
| limit | integer | 1ページあたりの件数（既定値は実装で決定） |

**レスポンス 200:**
```json
{
  "items": [
    {
      "id": "uuid-1",
      "test_case_id": "uuid-tc",
      "actor": "user:uuid-user-1",
      "action": "status_changed",
      "delta": {
        "status": {
          "before": "draft",
          "after": "approved"
        }
      },
      "created_at": 1719582600000
    },
    {
      "id": "uuid-2",
      "test_case_id": "uuid-tc",
      "actor": "user:uuid-user-1",
      "action": "updated",
      "delta": {
        "then": {
          "before": "エラーが返る",
          "after": "エラーコード CARD_EXPIRED が返る"
        },
        "category": {
          "before": "normal",
          "after": "abnormal"
        }
      },
      "created_at": 1719582300000
    },
    {
      "id": "uuid-3",
      "test_case_id": "uuid-tc",
      "actor": "token:uuid-token-1",
      "action": "imported",
      "delta": null,
      "created_at": 1719568800000
    }
  ],
  "next_cursor": null,
  "has_more": false
}
```

### Actor の解決

actor フィールドは `user:<id>` または `token:<id>` の型付き参照。UI で表示名を解決するには以下のアプローチ:

- **ユーザー:** 認証済みユーザー情報キャッシュまたは別途取得で `display_name` と `role` を解決
- **トークン:** トークン一覧 API（admin 限定）から `name` を解決。権限不足時はそのまま `token:<id>` 表示

---

## 画面遷移

| 操作 | 遷移先 |
|---|---|
| 基本情報タブクリック | S-10 基本情報 |
| Gherkin タブクリック | S-13 Gherkin ビュー |
| 構造化 Diff タブクリック | S-12 構造化 Diff ビュー |
| Identity 情報タブクリック | S-10 Identity 情報 |

---

## エラー状態

| エラー | HTTP | code | UI 表示 |
|---|---|---|---|
| 認証エラー | 401 | `UNAUTHORIZED` | ログイン画面にリダイレクト |
| リソース不在 | 404 | `NOT_FOUND` | 「テストケースが見つかりません。」 |
| サーバーエラー | 500 | — | 「変更履歴の取得に失敗しました。再読み込みしてください。」 |

---

## トースト・通知

この画面はデータの読み取りのみのため、成功トーストは原則不要。エラー時のみ表示する。

| 操作 | 結果 | メッセージ |
|---|---|---|
| 履歴取得失敗 | error | 「変更履歴の取得に失敗しました。」 |
| 追加読み込み失敗 | error | 「追加の履歴を読み込めませんでした。再試行してください。」 |
