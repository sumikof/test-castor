# 認証・認可・セキュリティ

TMS Web Service の認証・認可・テナント境界・流量制御の実装仕様。

関連ドキュメント:
- [データモデル](data-model.md) — User / Session / ApiToken エンティティ定義
- [API リファレンス](api-reference.md) — エンドポイント一覧・共通仕様
- [アーキテクチャ](architecture.md) — ポータビリティ境界の全体像

---

## 認証方式

TMS は2つの独立した認証方式を持つ。それぞれの到達可能範囲は完全に分離される。

| 方式 | 主体 | 用途 | スコープ |
|---|---|---|---|
| セッション Cookie | UI ユーザー | ブラウザ操作 | Organization（role 付き） |
| Bearer トークン | 衛星サービス | 同期 API | Project（role なし） |

---

## UI セッション認証

### パスワード保存

PHC string 形式で保存する。アルゴリズム識別子・パラメータ・ソルト・ハッシュを1文字列に内包する。

```
$pbkdf2-sha256$i=600000$<16-byte-CSPRNG-salt-base64>$<hash-base64>
```

- **既定アルゴリズム:** WebCrypto PBKDF2-SHA256
- **イテレーション:** 600,000（OWASP 2023 基準）
- **ソルト:** 16 バイト CSPRNG（per-user）
- **透過再ハッシュ:** ログイン成功時にプレフィックスでアルゴリズム判定し、旧形式なら新形式で再ハッシュして保存。argon2 への無停止移行を可能にする。
- **実装場所:** `Auth` インターフェース裏に隔離

### パスワードポリシー

- **長さ:** 最小 8 文字・最大 128 文字
- **複雑性要件:** なし（NIST SP 800-63B 準拠。総当たり耐性はレートリミット + PBKDF2 600,000 回反復で担保する）
- **実装:** 共有 Zod スキーマ（`src/schemas/limits.ts` の `passwordSchema`）で一元定義し、S-01（初期セットアップ）・S-19（ユーザー作成・編集）・S-20（プロフィール・パスワード変更）・対応する全 API で同一検証を行う

### セッション管理

セッションは D1/SQLite 上の `Session` テーブルで管理する（KV 依存を排除しポータビリティ維持）。Cookie には署名付きセッション ID のみを載せる。

**有効期限（スペック D-14）:** 7 日固定（`604800000` ms）。スライディング延長は行わない（1回発行されたセッションは、途中の操作有無に関わらず7日で必ず失効する）。環境変数 `SESSION_TTL_MS` で変更可能（既定値は上記7日）。

**Cookie 属性（必須）:**

```
HttpOnly; Secure; SameSite=Lax; Path=/
```

**署名鍵:**
- Secret 管理（CF Secret / オンプレは secret manager）。環境変数 `SESSION_SIGNING_KEYS`（JSON `{"<keyId>":"<secret>"}` 形式）で読み込む
- 鍵 ID をプレフィックスに埋め込み、新鍵発行・旧鍵検証の猶予期間で無停止ローテーション
- **運用規約:** 新規署名に使う鍵は環境変数 `SESSION_ACTIVE_KEY_ID` で明示指定する。`SESSION_SIGNING_KEYS` に鍵が1個しかない場合は省略可（その鍵が自動的に active になる）が、**複数鍵を設定する場合は `SESSION_ACTIVE_KEY_ID` の設定が必須**（未設定はどの鍵を新規署名に使うべきか曖昧なため起動時エラーとする）。鍵 ID に数字のみの文字列（例: `"1"`, `"2"`）は使用できない（JS のオブジェクトが整数様キーを宣言順ではなく数値昇順で列挙する仕様により、鍵ローテーション時に意図しない鍵が選ばれる footgun を防ぐため）

**検証フロー（三段 AND）:**

```
署名検証 → DB 存在確認 → expires_at > now
```

すべて通過しなければ 401。超過セッションは行削除。

**不変条件:**
- ログイン成功時にセッション ID を必ず再発行する（セッション固定攻撃対策）
- ログアウト API で Session 行を削除する
- パスワード変更・role 変更時は当該 user の全セッションを無効化する（`DELETE FROM Session WHERE user_id = ?`）

### CSRF 防御

方式はスペック D-09: HttpOnly Cookie + サーバー埋込型 double-submit。

- **一次防御:** `SameSite=Lax`
- **二次防御:** 状態変更メソッド（POST / PATCH / DELETE / **PUT**）に double-submit CSRF トークンを必須とする（PUT は現状ルート未定義だが、将来の追加に備えた防御として実装済み）
- セッション発行時に 32 バイトランダムの CSRF トークンを `HttpOnly; Secure; SameSite=Lax` Cookie で配布する
- SSR が全フォームの hidden input と `<body hx-headers='{"X-CSRF-Token": ...}'>` に同一値を埋め込む。HTMX はこの `hx-headers` で CSRF トークンを全変更リクエストに自動付与する
- ミドルウェアが上記4メソッドで Cookie 値と送信値の一致を検証する。不一致は 403 `FORBIDDEN`
- Bearer トークン認証のリクエスト（衛星）は Cookie を使わないため CSRF 検証対象外
- **不変条件:** GET は副作用なし（CSRF 対策不要を前提とする）

---

## API トークン認証（衛星サービス用）

### トークン生成

| 項目 | 仕様 |
|---|---|
| エントロピー | `crypto.getRandomValues` で 32 バイト以上 |
| エンコード | base64url |
| プレフィックス | 識別子付き（例: `tms_...`） |
| 検証 | Zod で長さ下限を検証し「高エントロピー前提」を契約化 |

### トークン保存・照合

- **保存形式:** 決定的 SHA-256（salt なし）
- **照合:** `token_hash` 列にインデックス → Bearer 受信時に完全一致で O(1) シーク
- **安全性の根拠:** 32 バイト以上の CSPRNG による高エントロピートークン前提

### 失効

ソフト失効（`revoked_at` を打つ）。失効は記録列ではなく認証述語に内包する:

```sql
SELECT ... WHERE token_hash = ? AND revoked_at IS NULL
```

ヒットしなければ 401。失効済みトークンは「存在しない」として弾かれる。

### 平文の隔離

- 発行レスポンスに `Cache-Control: no-store`
- 平文はログ・`TestCaseHistory`・監査・エラーボディに一切含めない
- 記録は `token:<id>` 形式のみ

### ライフサイクル API（admin 限定）

| 操作 | エンドポイント | 備考 |
|---|---|---|
| 発行 | `POST /api/v1/projects/:pid/tokens` | レスポンス body で平文を1回だけ返す。以後取得不可 |
| 一覧 | `GET /api/v1/projects/:pid/tokens` | id / name / created_at / revoked_at / last_used_at のみ |
| 失効 | `DELETE /api/v1/projects/:pid/tokens/:id` | `revoked_at` を打つソフト失効 |

### last_used_at 更新

- best-effort・非ブロッキング（更新失敗で認証を落とさない）
- 間引き更新（前回更新から閾値（例: 1分）経過時のみ）で D1 単一ライタ負荷を回避

---

## テナント境界

マルチテナントの論理境界を最初から全データアクセスに通す。

### 構造的保証

1. `Organization` を第一級エンティティとし、`Project.organization_id` を必須 FK にする
2. `Storage` インターフェースの大多数のメソッドが `orgScope` を必須引数とする — 越境クエリをコンパイル時に防止。以下は意図的な例外（実装済み）:
   - **認証解決系**（org がまだ判明していない時点で呼ばれる。以後の処理は必ず scope 付きメソッドを経由する）: `findUserForLogin`（ログイン時の email 検索）・`getUserById`（セッション→ユーザー解決。authn ミドルウェア専用、API ハンドラでの直接使用は禁止）
   - **メンテナンス系**（project 横断・システム全体の運用操作であり、特定 org の業務データ操作ではないため。CF の scheduled Cron と、オンプレの `maintenance-cli` の両方から共通実装を呼ぶ）: `purgeObservations`（観測パージ）・`sweepExpiredSyncSessions`（失効セッション sweep）・`deleteExpiredUiSessions`（UI セッションパージ）・`purgeSyncWorkdata`（同期作業データパージ）・`countsSnapshot`（容量監視用の行数スナップショット）
3. API トークンは project スコープ（→ org）。`:pid` の org 不一致は **403**
4. MVP は単一 org を seed して運用するが、コードパスは常に org を通す

### IDOR の構造防止

フラットパスを廃止し、全リソースを `/api/v1/projects/:pid/...` 配下に階層化する。

共通前段ミドルウェアが `id → project_id → organization_id` を1クエリで解決し、リクエスタのスコープと不一致なら **404**（存在隠蔽 = 列挙攻撃の無効化）。検証済み scope を downstream に注入し、ハンドラ個別の認可漏れを根絶する。

---

## 認証・認可ミドルウェア執行仕様

各ルートに能力メタデータ（許可認証方式・最低 role）を型付き宣言し、共通ミドルウェアが機械的に執行する。

### 到達面分離（能力マトリクス）

| 主体 | 認証方式 | 到達可能 | 禁止（→ 403） |
|---|---|---|---|
| 衛星トークン | Bearer（project scope・role なし） | `POST /sync/*`、自 project の参照系 GET | testcase PATCH/DELETE/status 変更・token 管理・project 作成 |
| UI ユーザー | セッション Cookie（org scope・role 有り） | role 準拠の CRUD・status・archive・token 管理 | 他 org（→ 404）・role 超過（→ 403） |

### ロールベースアクセス制御（RBAC）

| 操作 | 最低 role |
|---|---|
| 参照系 GET | viewer |
| testcase 作成・編集・status 変更・archive | editor |
| token 発行・失効・project 作成・user 管理 | admin |

### 失効・有効性の執行

失効・有効性チェックを「認証述語」に内包する（記録列ではなく執行点に置く）。

- **トークン:** `WHERE token_hash = ? AND revoked_at IS NULL`
- **セッション:** `WHERE id = ? AND expires_at > :now`

三段 AND（署名検証 → DB 存在 → 未失効）を共通関数化し、全保護ルートが必ず通る。

---

## 流量制御（レートリミット）

### ポータビリティ境界

`RateLimiter` は `Storage` / `Auth` に続く**第4のポータビリティ境界**として定義する。アプリ本体は `RateLimiter` インターフェースのみ参照する。

**実装済みの事実（D-14）:** ログイン・衛星トークンの両方とも、CF / オンプレを問わず**全環境でインメモリ実装**（プロセス内カウンタ、固定ウィンドウ）を使う。CF の Workers Rate Limiting binding は固定ウィンドウ（10秒/60秒）のみをサポートし、ログインに必要な15分ウィンドウを表現できないため採用していない。Redis 等の外部ストアアダプタも現時点では未実装。`RateLimiter` インターフェースはポータビリティ境界として将来の差し替え（例: 複数 isolate/プロセス間で状態を共有する必要が生じた場合の外部ストア化）に備えたものであり、MVP 時点の実装は単一のインメモリアダプタのみ。

**位置づけ:** best-effort・eventually consistent（インメモリのためプロセス/isolate 再起動でカウンタがリセットされる。CF の Workers はisolateごとに独立したカウンタを持つ）。D1 にカウンタ行を置く方式は単一ライタ自己圧迫のため不採用。

### 衛星トークン向け流量制限

トークン別に**120 リクエスト / 分**（D-14）を上限とする。fingerprint の暴走（observation insert 頻度の異常）も間接的にこの制限で緩和され、D1 容量爆発を防ぐ。

### 認証ブルートフォース防御

衛星トークン用の流量制限とは**別立て**で実装する。

| 項目 | 仕様 |
|---|---|
| 単位 | `(email, IP)` 別のカウンタ（上記「流量制御」と同じインメモリ `RateLimiter` 実装。永続ストアではない） |
| 具体値（D-14） | **5 失敗 / 15 分 → 429**（固定ウィンドウ）。正しいパスワードでの試行はカウントに含めない（非対称消費） |
| 対策 | 固定ウィンドウのみ。**指数バックオフは未実装**（ウィンドウ経過で即座にリセットされる） |
| 記録（D-11） | 認証失敗イベントを構造化 JSON ログ（`console.warn`。`{"event":"auth_failure","email":...,"ip":...,"at":...}`）として出力する。D1 等への永続監査テーブルは持たない（TestCaseHistory とは完全に別のログ経路）。CF は Workers Logs / Logpush、オンプレは標準出力の収集基盤（例: journald・ログドライバ）で監査する運用を前提とする |

---

## Auth インターフェース抽象化

認証ロジックは `Auth` インターフェースとして抽象化する。

```
アプリ本体 → Auth インターフェース ← 実装アダプタ
                                       ├─ 内蔵実装（PBKDF2 / Session / Cookie）
                                       └─ 外部 IdP アダプタ（オンプレ差し替え用）
```

- Cloudflare Access は「使うなら前段の任意オプション」であり、本体は依存しない
- オンプレでは外部 IdP（LDAP / OIDC 等）への差し替えが可能
- パスワードハッシュ・セッション管理・トークン検証のすべてが `Auth` 裏に隔離される

---

## セキュリティ不変条件まとめ

| 不変条件 | 保証手段 |
|---|---|
| テナント越境不可 | Storage の業務データ操作メソッドは orgScope 必須（意図的な例外は「構造的保証」参照）・ミドルウェア前段検証 |
| IDOR 不可 | パス階層化 + id → org 解決 + 不一致 404 |
| セッション固定不可 | ログイン成功時にセッション ID 再発行 |
| 失効トークン素通り不可 | 認証述語に失効チェック内包 |
| トークン平文漏洩不可 | SHA-256 ハッシュのみ保存・ログ/履歴/エラーに含めない |
| CSRF 不可 | SameSite=Lax + double-submit token（状態変更メソッド） |
| パスワード総当たり不可 | `(email, IP)` 別レートリミット（固定ウィンドウ 5失敗/15分 → 429。D-14） |
| History 改竄不可 | TestCaseHistory は追記専用（UPDATE/DELETE 禁止） |
| viewer 越権不可 | ルートメタデータ駆動 RBAC をミドルウェアが機械執行 |
