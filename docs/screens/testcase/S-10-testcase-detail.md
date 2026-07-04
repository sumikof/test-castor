# S-10 テストケース詳細

| 項目 | 値 |
|---|---|
| ID | S-10 |
| 画面名 | テストケース詳細 |
| 種別 | ページ |
| URL | `/projects/:pid/testcases/:id` |
| 対応 UC | UC-10, UC-11, UC-13, UC-15, UC-16, UC-20, UC-21, UC-28 |
| 最低ロール | viewer（ステータス変更・編集・アーカイブは editor+） |
| スペック | 定義済み |

---

## ワイヤーフレーム

```
┌──────────────────────────────────────────────────────────────┐
│ ← テストケース一覧                                           │
│                                                              │
│ 有効期限切れカードで決済を試みるとエラーが返る                │
│ ステータス: [draft ▼]  所有権: human                         │
│ [drift ⚡ 解消する]  [stale 🔺 origin-1]                     │
│                                                [編集]        │
│                                                              │
│ [基本情報] [Gherkin] [構造化Diff] [変更履歴] [Identity情報]  │
│ ─────────────────────────────────────────────────────────    │
│                                                              │
│ 対象:     com.example.PaymentService#charge                  │
│ カテゴリ: 異常系                                             │
│                                                              │
│ Given:                                                       │
│   有効期限が過去のカード情報が登録されている                  │
│                                                              │
│ When:                                                        │
│   そのカードで 1,000 円の決済を実行する                       │
│                                                              │
│ Then:                                                        │
│   決済が拒否され、エラーコード CARD_EXPIRED が返る            │
│                                                              │
│ パラメータ: なし                                             │
│                                                              │
│ メタデータ:                                                  │
│   タグ: [payment] [card-validation]                          │
│   作成元: discovery                                          │
│                                                              │
│                                          [アーカイブ]        │
└──────────────────────────────────────────────────────────────┘
```

---

## 要素カタログ

### ヘッダー領域

| 要素名 | 種別 | data-testid | 条件付き表示 | 備考 |
|---|---|---|---|---|
| 戻るリンク | リンク | `link-back-to-list` | 常時 | 「← テストケース一覧」。S-08 に遷移 |
| タイトル | テキスト表示（h1） | `testcase-title` | 常時 | テストケース名 |
| ステータスドロップダウン | ドロップダウン | `select-status` | editor+: 操作可能 / viewer: 読み取り専用表示 | draft / approved / archived |
| 所有権表示 | テキスト+アイコン | `display-ownership` | 常時 | `machine` または `human` + アイコン |
| drift バッジ | バッジ | `badge-drift` | `drift=true` のときのみ表示 | ⚡ アイコン付き |
| stale バッジ | バッジ | `badge-stale` | `is_stale=true` のときのみ表示 | 🔺 アイコン + stale origin 名 |
| 編集ボタン | ボタン | `btn-edit` | editor+ かつ `status != archived` | S-11 編集モードに切替 |
| アーカイブボタン | ボタン | `btn-archive` | editor+ かつ `status != archived` | archived に変更 |
| 復帰ボタン | ボタン | `btn-restore` | editor+ かつ `status == archived` | draft に復帰 |

drift 解消ボタン（`btn-accept-fingerprint`）はヘッダー領域には配置しない。構造化 Diff タブ（S-12）内にのみ配置する（ヘッダーとタブ内の両方に置くと、同一 `data-testid` が1画面に重複し E2E テストで危険なため）。詳細は [S-12「アクション」](./S-12-structured-diff.md)を参照。

### ステータスドロップダウンの遷移制約

| 現在の status | 選択可能な値 | 備考 |
|---|---|---|
| draft | `approved`, `archived` | — |
| approved | `draft`, `archived` | draft = 差し戻し |
| archived | `draft` のみ | approved への直接遷移は不可 |

ステータス変更時、確認ダイアログを表示:
- draft → approved: 「このテストケースを承認しますか？」
- approved → draft: 「承認を取り消し、下書きに戻しますか？」
- \* → archived: 「このテストケースをアーカイブしますか？」
- archived → draft: 「このテストケースを復帰しますか？」

### タブバー

| 要素名 | 種別 | data-testid | 条件付き表示 | 備考 |
|---|---|---|---|---|
| 基本情報タブ | タブ | `tab-basic-info` | 常時 | デフォルトアクティブ |
| Gherkin タブ | タブ | `tab-gherkin` | 常時 | S-13 Gherkin ビュー |
| 構造化 Diff タブ | タブ | `tab-diff` | 常時クリック可能（drift 時にドットインジケータ付き。スペック D-13-4） | S-12 構造化 Diff。drift 時に `●` 表示 |
| 変更履歴タブ | タブ | `tab-history` | 常時 | S-14 変更履歴 |
| Identity 情報タブ | タブ | `tab-identities` | 常時 | per-origin の同定情報 |

### 基本情報タブ（デフォルト）

| 要素名 | 種別 | data-testid | 備考 |
|---|---|---|---|
| 対象 (target) | テキスト表示 | `display-target` | 未設定の場合「—」表示 |
| カテゴリ | バッジ表示 | `display-category` | 日本語ラベル（正常系/異常系/境界値/エラーハンドリング） |
| Given セクション | テキスト表示 | `display-given` | 複数行対応 |
| When セクション | テキスト表示 | `display-when` | 複数行対応 |
| Then セクション | テキスト表示 | `display-then` | 複数行対応 |
| パラメータテーブル | テーブル表示 | `display-parameters` | null/空の場合「なし」表示 |
| パラメータ行 | テーブル行 | `param-display-row-{index}` | name, inputs, expected の 3 列 |
| メタデータセクション | コンテナ | `display-metadata` | — |
| タグバッジ | バッジ | `display-tag-{value}` | 読み取り専用表示 |
| 作成元 (created_origin) | テキスト表示 | `display-origin` | `manual` / `discovery` 等 |
| 信頼度 (confidence) | テキスト表示 | `display-confidence` | null の場合非表示。0.0〜1.0 の値 |
| ソース参照 (source_ref) | テキスト/リンク | `display-source-ref` | null の場合非表示。ファイルパス + 行番号 |
| 作成日時 | テキスト表示 | `display-created-at` | — |
| 更新日時 | テキスト表示 | `display-updated-at` | — |
| バージョン | テキスト表示 | `display-version` | OCC バージョン番号 |

### Identity 情報タブ

| 要素名 | 種別 | data-testid | 備考 |
|---|---|---|---|
| Identity テーブル | テーブル | `identity-table` | — |
| Identity 行 | テーブル行 | `identity-row-{id}` | — |
| origin 列 | テキスト | `identity-origin-{id}` | 衛星識別子 |
| external_ref 列 | テキスト | `identity-ref-{id}` | 当該 origin の参照 ID |
| stale 状態列 | バッジ | `identity-stale-{id}` | per-origin stale 状態。true で 🔺 表示 |
| 最終観測日時列 | テキスト | `identity-last-seen-{id}` | — |

---

## 状態バリエーション

| 状態 | 表示変化 |
|---|---|
| viewer ロール | ステータスは読み取り専用テキスト。編集・アーカイブ・復帰・drift解消ボタン非表示 |
| editor+ ロール | 全操作要素が表示 |
| status=draft | 編集・アーカイブボタン表示。復帰ボタン非表示 |
| status=approved | 編集・アーカイブボタン表示。復帰ボタン非表示 |
| status=archived | 復帰ボタン表示。編集・アーカイブボタン非表示。ステータスドロップダウンは draft のみ選択可 |
| ownership=machine | 所有権に 👻 アイコン表示 |
| ownership=human | 所有権に人型アイコン表示 |
| drift=true | drift バッジ + 解消ボタン表示。構造化 Diff タブにドットインジケータ |
| drift=false | drift バッジ非表示 |
| is_stale=true | stale バッジ + stale origin 名表示 |
| is_stale=false | stale バッジ非表示 |
| parameters=null | 「パラメータ: なし」表示 |
| parameters あり | パラメータテーブル表示 |
| confidence=null | 信頼度セクション非表示 |
| source_ref=null | ソース参照セクション非表示 |
| 編集モード（S-11） | 基本情報タブの表示内容がフォームに切り替わる |

---

## API コール

| トリガー | メソッド | パス | ヘッダ/パラメータ | レスポンス処理 |
|---|---|---|---|---|
| 画面表示 | GET | `/api/v1/projects/:pid/testcases/:id` | — | `ETag` ヘッダを保持（OCC 用）。レスポンスで全フィールド描画 |
| ステータス変更 | PATCH | `/api/v1/projects/:pid/testcases/:id` | `If-Match: "<version>"`, body: `{ "status": "..." }` | 200 → 画面再描画 + 新 ETag 保持 |
| アーカイブ | PATCH | `/api/v1/projects/:pid/testcases/:id` | `If-Match: "<version>"`, body: `{ "status": "archived" }` | 200 → 画面再描画 |
| 復帰 | PATCH | `/api/v1/projects/:pid/testcases/:id` | `If-Match: "<version>"`, body: `{ "status": "draft" }` | 200 → 画面再描画 |
| drift 解消 | POST | `/api/v1/projects/:pid/testcases/:id/accept-fingerprint` | `If-Match: "<version>"` | 200 → drift=false に更新、新 ETag 保持 |
| Identity 情報タブ表示 | GET | `/api/v1/projects/:pid/testcases/:id/identities` | — | `{ items: [...] }` で Identity テーブル描画 |
| Gherkin タブ表示 | GET | `/api/v1/projects/:pid/testcases/:id?format=gherkin` | — | text/plain レスポンスを整形表示 |
| 構造化 Diff タブ表示 | GET | `/api/v1/projects/:pid/testcases/:id/diff` | — | diff オブジェクトでフィールド差分を描画 |
| 変更履歴タブ表示 | GET | `/api/v1/projects/:pid/testcases/:id/history` | `cursor?`, `limit?` | `{ items, next_cursor, has_more }` で時系列表示 |

---

## 画面遷移

| アクション | 遷移先 | 備考 |
|---|---|---|
| 戻るリンク押下 | S-08 テストケース一覧 | — |
| 編集ボタン押下 | S-11 テストケース編集（ページ内モード） | 基本情報タブがフォームに切り替わる |
| Gherkin タブ | S-13 Gherkin ビュー（タブ内） | — |
| 構造化 Diff タブ | S-12 構造化 Diff ビュー（タブ内） | — |
| 変更履歴タブ | S-14 変更履歴（タブ内） | — |
| アーカイブ後 | 自画面（status=archived で再描画） | archived 状態の詳細表示 |

---

## エラー状態

| エラー | HTTP | コード | 表示 |
|---|---|---|---|
| テストケース未存在 | 404 | `NOT_FOUND` | 「テストケースが見つかりません」エラーページ |
| 認証切れ | 401 | `UNAUTHORIZED` | ログイン画面にリダイレクト |
| OCC 競合（ステータス変更時） | 409 | `OCC_CONFLICT` | トースト「更新が競合しました。最新の内容を確認してください」+ 再読み込みボタン |
| If-Match 未指定 | 428 | `PRECONDITION_REQUIRED` | クライアントバグ（ユーザーには表示されない想定） |
| drift 未発生で accept-fingerprint | 422 | `NO_DRIFT` | トースト「このテストケースには drift が発生していません。」（S-12 と共通の文言） |

---

## トースト/通知メッセージ

| トリガー | 種別 | メッセージ |
|---|---|---|
| ステータス → approved | 成功 | 「テストケースを承認しました」 |
| ステータス → draft（差し戻し） | 成功 | 「テストケースを下書きに戻しました」 |
| ステータス → archived | 成功 | 「テストケースをアーカイブしました」 |
| archived → draft（復帰） | 成功 | 「テストケースを復帰しました」 |
| accept-fingerprint 成功 | 成功 | 「drift を解消しました」 |
| OCC 競合 | エラー | 「更新が競合しました。最新の内容を確認してください」 |
| 編集保存成功（S-11 から） | 成功 | 「テストケースを更新しました」 |
| machine→human 遷移発生 | 情報 | 「所有権が machine から human に変更されました。以後 Discovery の自動更新は停止します」 |

---

## 確認ダイアログ

| トリガー | data-testid | タイトル | 本文 | ボタン |
|---|---|---|---|---|
| ステータス → approved | `dialog-confirm-approve` | ステータスの変更 | 「このテストケースを承認しますか？」 | [キャンセル] [承認] |
| ステータス → draft | `dialog-confirm-revert` | ステータスの変更 | 「承認を取り消し、下書きに戻しますか？」 | [キャンセル] [差し戻し] |
| ステータス → archived | `dialog-confirm-archive` | アーカイブ | 「このテストケースをアーカイブしますか？」 | [キャンセル] [アーカイブ] |
| archived → draft | `dialog-confirm-restore` | 復帰 | 「このテストケースを復帰しますか？」 | [キャンセル] [復帰] |
| accept-fingerprint | `dialog-confirm-accept-fp` | drift の解消 | 「最新の観測を正として受け入れ、drift を解消しますか？」 | [キャンセル] [解消する] |
