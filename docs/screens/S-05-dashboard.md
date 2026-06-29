# S-05 ダッシュボード

| 項目 | 内容 |
|---|---|
| **画面 ID** | S-05 |
| **画面名** | ダッシュボード |
| **種別** | ページ |
| **URL** | `/dashboard` |
| **対応 UC** | UC-22 |
| **必要ロール** | viewer 以上（全認証済みユーザー） |
| **スペック状況** | `[※]` MVP 後 |

## 概要

プロジェクト横断でテスト管理状況を俯瞰する画面。ログイン後の最初のランディングページ。集計 API が未定義のため MVP 後の実装予定。MVP ではログイン後に S-06 プロジェクト一覧へ直接遷移する。

---

## ワイヤーフレーム

```
┌──────────────────────────────────────────────────────────┐
│ [グローバルヘッダー]                                      │
├──────────────────────────────────────────────────────────┤
│ ダッシュボード                                           │
│                                                          │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐         │
│ │ テスト総数   │ │ 未レビュー  │ │ 要対応      │         │
│ │    342       │ │    28       │ │    12       │         │
│ │              │ │ (machine    │ │ (drift: 8   │         │
│ │ approved:280 │ │  +draft)    │ │  stale: 4)  │         │
│ │ draft: 50    │ │             │ │             │         │
│ │ archived: 12 │ │             │ │             │         │
│ └─────────────┘ └─────────────┘ └─────────────┘         │
│                                                          │
│ プロジェクト別サマリー                                   │
│ ┌────────────────────────────────────────────────┐       │
│ │ プロジェクト    approved  draft  drift  stale  │       │
│ │ payment-service   120     15      3      1     │       │
│ │ user-service       95     20      4      2     │       │
│ │ order-service      65     15      1      1     │       │
│ └────────────────────────────────────────────────┘       │
│                                                          │
│ 最近のアクティビティ                                     │
│  14:30  田中  payment-service  テストケース承認 (5件)    │
│  13:15  CI    user-service     Discovery同期完了          │
│  11:00  佐藤  order-service    drift解消                  │
└──────────────────────────────────────────────────────────┘
```

---

## 要素カタログ

### サマリーカード

| 要素名 | 種別 | data-testid | 説明 | 条件付き表示 |
|---|---|---|---|---|
| テスト総数カード | card | `summary-card-total` | テストケース総数を表示 | 常時表示 |
| テスト総数値 | text-display | `summary-total-count` | 全テストケース数 | — |
| approved 件数 | text-display | `summary-total-approved` | 承認済み件数 | — |
| draft 件数 | text-display | `summary-total-draft` | 下書き件数 | — |
| archived 件数 | text-display | `summary-total-archived` | アーカイブ件数 | — |
| 未レビューカード | card | `summary-card-unreviewed` | 未レビュー（machine+draft）件数 | 常時表示 |
| 未レビュー件数値 | text-display | `summary-unreviewed-count` | machine 所有 + draft の件数 | — |
| 未レビューカード（クリック） | link | `summary-card-unreviewed` | クリックで S-08（フィルタ適用済み）に遷移 `[※]` | — |
| 要対応カード | card | `summary-card-action-required` | 要対応（drift + stale）件数 | 常時表示 |
| 要対応件数値 | text-display | `summary-action-required-count` | drift + stale の合計件数 | — |
| drift 件数 | text-display | `summary-drift-count` | drift 発生中の件数 | — |
| stale 件数 | text-display | `summary-stale-count` | stale の件数 | — |
| 要対応カード（クリック） | link | `summary-card-action-required` | クリックで S-08（フィルタ適用済み）に遷移 `[※]` | — |

### プロジェクト別サマリーテーブル

| 要素名 | 種別 | data-testid | 説明 | 条件付き表示 |
|---|---|---|---|---|
| サマリーテーブル | table | `project-summary-table` | プロジェクト別の集計テーブル | 常時表示 |
| プロジェクト名セル | link | `project-summary-name-{index}` | プロジェクト名。クリックで S-08 に遷移 | — |
| approved 列 | text-display | `project-summary-approved-{index}` | プロジェクト別 approved 件数 | — |
| draft 列 | text-display | `project-summary-draft-{index}` | プロジェクト別 draft 件数 | — |
| drift 列 | text-display | `project-summary-drift-{index}` | プロジェクト別 drift 件数 | — |
| stale 列 | text-display | `project-summary-stale-{index}` | プロジェクト別 stale 件数 | — |

### 最近のアクティビティ

| 要素名 | 種別 | data-testid | 説明 | 条件付き表示 |
|---|---|---|---|---|
| アクティビティフィード | list | `activity-feed` | 最近のアクション一覧 | 常時表示 |
| アクティビティ項目 | list-item | `activity-item-{index}` | 個別のアクティビティエントリ | — |
| アクティビティ日時 | text-display | `activity-time-{index}` | 操作日時 | — |
| アクティビティユーザー | text-display | `activity-user-{index}` | 操作者名 | — |
| アクティビティプロジェクト | text-display | `activity-project-{index}` | 対象プロジェクト名 | — |
| アクティビティ内容 | text-display | `activity-action-{index}` | 操作の内容 | — |

---

## 状態バリエーション

| 状態 | 表示内容 |
|---|---|
| プロジェクト 0 件 | サマリーテーブル空、「プロジェクトを作成してください」の案内表示 |
| テストケース 0 件 | 全カウント 0、アクティビティフィード空 |
| 通常状態 | 全セクションにデータが表示される |
| drift/stale なし | 要対応カードの件数が 0、バッジなし |

---

## API 呼び出し

| メソッド | パス | トリガー | 説明 |
|---|---|---|---|
| — | `[※]` 未定義 | 画面表示時 | ダッシュボード用集計 API は未定義。MVP 後に設計が必要 |

> **注:** ダッシュボード用の集計 API（プロジェクト横断サマリー、アクティビティフィード）は未設計。実装時に以下の API 設計が必要:
> - `GET /api/v1/dashboard/summary` — テストケース総数・ステータス別集計
> - `GET /api/v1/dashboard/activity` — 直近アクティビティフィード

---

## 画面遷移

| アクション | 遷移先 | 条件 |
|---|---|---|
| サマリーカード（未レビュー）クリック | S-08 テストケース一覧（`status=draft&ownership=machine`） | `[※]` |
| サマリーカード（要対応）クリック | S-08 テストケース一覧（`drift=true` or `is_stale=true`） | `[※]` |
| プロジェクト名クリック | S-08 テストケース一覧（該当プロジェクト） | — |
| サマリー数値クリック | S-08 テストケース一覧（対応フィルタ適用済み） | `[※]` |
| ヘッダー: プロジェクト | S-06 プロジェクト一覧 | — |
| ヘッダー: ユーザー管理 | S-18 ユーザー一覧 | admin のみ |
| ヘッダー: プロフィール | S-20 プロフィール | — |
| ヘッダー: ログアウト | S-02 ログイン | — |

---

## エラー状態

| エラー | 表示 |
|---|---|
| 未認証（セッション切れ） | S-02 ログインへリダイレクト |
| API エラー（集計取得失敗） | エラートースト「データの読み込みに失敗しました」 |

---

## トースト・通知

この画面ではトースト通知の発生はない（表示専用画面）。他画面からの遷移時に前画面のトーストが残っている場合がある。
