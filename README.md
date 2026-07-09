# TMS Web Service

Agentic QA プラットフォームのハブとなる、構造化テストケース管理 Web サービス。
Cloudflare Workers + Hono + Drizzle ORM + Zod + Hono JSX(SSR) + HTMX で構築し、
オンプレ(Node.js + better-sqlite3)にも同一アプリを移植可能な設計。

## ドキュメント

設計・仕様の正本は `docs/` 配下、実装計画・決定事項は `docs/superpowers/` 配下を参照。

| ドキュメント | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | プラットフォーム全体像・レイヤ構成・技術スタック |
| [docs/data-model.md](docs/data-model.md) | エンティティ定義・関係・状態機械 |
| [docs/api-reference.md](docs/api-reference.md) | REST API 仕様（索引・共通仕様） |
| [docs/sync-protocol.md](docs/sync-protocol.md) | 衛星同期プロトコル（start/chunk/commit） |
| [docs/auth-security.md](docs/auth-security.md) | 認証・認可・セキュリティ |
| [docs/operations.md](docs/operations.md) | テスト方針・パフォーマンス・DB 運用 |
| [docs/development.md](docs/development.md) | 開発・ローカル実行・テストの手順（node22 前提・3 起動経路・トラブルシュート） |
| [docs/usecase.md](docs/usecase.md) | ユースケース（操作フロー） |
| [docs/screens.md](docs/screens.md) | 画面一覧・画面遷移図 |
| [docs/superpowers/specs/2026-07-02-tms-mvp-build-design.md](docs/superpowers/specs/2026-07-02-tms-mvp-build-design.md) | MVP 構築スペック（決定の正本） |

## 開発コマンド

| コマンド | 内容 |
|---|---|
| `npm install` | 依存パッケージのインストール（postinstall で htmx を `public/` に配置） |
| `npm run dev` | `wrangler dev` でローカル起動 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | Vitest（node pool）: 単体テスト・better-sqlite3/libSQL 契約テスト |
| `npm run test:workers` | Vitest（workers pool, `@cloudflare/vitest-pool-workers`）: 統合テスト・D1 契約テスト |
| `npm test` | `test:unit` → `test:workers` を順に実行 |
| `npm run db:generate` | `drizzle-kit generate` でマイグレーション SQL を生成 |
| `npm run start:node` | Node.js 単体(better-sqlite3)でアプリを起動。詳細は「オンプレ起動」参照 |
| `npm run maintenance:node` | オンプレ向けメンテナンス CLI(観測パージ・sweep・vacuum)を1回実行。詳細は「オンプレ起動」参照 |

> ローカル実行・テストの詳細手順（node22 前提、wrangler / Node / Docker の 3 経路、単体テストの絞り込み実行、トラブルシュート）は **[docs/development.md](docs/development.md)** を参照。

## Cloudflare へのデプロイ手順

1. **D1 データベースを作成する。**

   ```bash
   wrangler d1 create tms
   ```

   出力される `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id`(既定値 `REPLACE_ON_DEPLOY`)に差し替える。

2. **セッション署名鍵を secret として投入する。**

   ```bash
   wrangler secret put SESSION_SIGNING_KEYS
   # 例: {"k1":"<32バイト以上のランダム文字列>"}
   ```

   `SESSION_SIGNING_KEYS` は `{"<keyId>":"<secret>"}` 形式の JSON(鍵 ID は数字のみ禁止。複数鍵を設定する場合は `SESSION_ACTIVE_KEY_ID` の設定も必須。詳細は [docs/auth-security.md](docs/auth-security.md) と `src/http/config.ts` を参照)。未設定のままデプロイすると、開発用フォールバック鍵で起動してしまうため必ず設定すること。

3. **マイグレーションを本番 D1 に適用する。**

   ```bash
   wrangler d1 migrations apply tms --remote
   ```

4. **デプロイする。**

   ```bash
   wrangler deploy
   ```

デプロイ後は「初期セットアップ」を参照して最初の組織・管理者を作成する。`wrangler.jsonc` の `triggers.crons`(既定 1 時間毎)により、観測パージ・失効セッション sweep 等のメンテナンスが Cron Triggers 経由で自動実行される([docs/operations.md](docs/operations.md) 参照)。

## オンプレ起動(Node.js + better-sqlite3)

Cloudflare Workers を使わず、Node.js 単体でも同一アプリ(`src/entry/node.ts`。better-sqlite3 でファイルに永続化)を起動できる。

```bash
TMS_DB_PATH=./tms.sqlite npm run start:node
```

起動後、ブラウザ(または curl)で `http://localhost:8788/setup` にアクセスして初期セットアップを行う(「初期セットアップ」参照)。

### 環境変数一覧

| 変数 | 既定値 | 説明 |
|---|---|---|
| `TMS_DB_PATH` | `./tms.sqlite` | SQLite ファイルパス(存在しなければ新規作成) |
| `PORT` | `8788` | 待ち受けポート(`src/entry/node.ts` のみが読む。Cloudflare 側には存在しない) |
| `SESSION_SIGNING_KEYS` | 開発用フォールバック `{"dev":"dev-insecure-key"}`(起動時に警告ログを出す) | セッション署名鍵。JSON `{"<keyId>":"<secret>"}` 形式。**本番相当の運用では必ず明示的に設定する** |
| `SESSION_ACTIVE_KEY_ID` | 単一鍵なら省略可 | 新規署名に使う鍵 ID。複数鍵設定時は必須(数字のみの鍵 ID は禁止。鍵ローテーションの運用は `src/http/config.ts` のコメント参照) |
| `SESSION_TTL_MS` | `604800000`(7日) | セッション有効期限(D-08。スライディング延長なしの固定期間) |
| `PBKDF2_ITERATIONS` | `600000` | パスワードハッシュの反復回数(OWASP 2023 基準) |
| `LOGIN_RATE_LIMIT_WINDOW_MS` / `LOGIN_RATE_LIMIT_MAX` | `900000` / `5` | ログイン試行のレート制限。`(email, IP)` 別、既定 5 失敗 / 15 分 |
| `SYNC_RATE_LIMIT_WINDOW_MS` / `SYNC_RATE_LIMIT_MAX` | `60000` / `120` | 衛星トークンのレート制限。トークン別、既定 120 リクエスト / 分 |
| `OBSERVATION_RETENTION_MS` | `7776000000`(90日) | committed 観測の保持期間(定期パージの基準) |
| `IDENTITY_TTL_MS` | `7776000000`(90日) | canonical rollup が参照する Identity の TTL |
| `SYNC_COMMIT_WINDOW_LIMIT` | `500` | commit 工程 3〜7 の1回の呼び出しあたり処理行数 |

いずれも未設定時は上記既定値にフォールバックするため、開発時は無指定でも起動できる(`SESSION_SIGNING_KEYS` 未設定時は警告ログが出る)。

### メンテナンス(OS cron)

観測パージ・失効 sweep・SyncStaging パージに加えて、オンプレ環境のみ `PRAGMA incremental_vacuum` を実行しファイルサイズを回収する(Cloudflare の Cron Triggers `scheduled()` ハンドラと同じ `runMaintenance` 共通実装を使用。差分は [docs/operations.md §4.3](docs/operations.md) 参照)。

```bash
TMS_DB_PATH=./tms.sqlite npm run maintenance:node
```

OS の cron から1時間毎に実行する例:

```
0 * * * * cd /path/to/tms-web-service && TMS_DB_PATH=/var/lib/tms/tms.sqlite node --import ./src/entry/node-ts-loader.mjs src/entry/maintenance-cli.ts >> /var/log/tms-maintenance.log 2>&1
```

(`npm run maintenance:node` と等価な内容を、cron 経由で環境変数を渡しやすいよう `node` 直接呼び出しの形で例示している。maintenance-cli は署名鍵設定 `SESSION_SIGNING_KEYS` を読まないため cron 側に渡す必要はない — 参照する env は `TMS_DB_PATH` と `OBSERVATION_RETENTION_MS` のみ)

## Docker / docker-compose 起動

オンプレ Node 版(`start:node`)を、`web`(HTTP)+ `maintenance`(定期パージ/vacuum)の2サービスで
コンテナ起動する。イメージはマルチステージ・非root。SQLite は名前付きボリューム `tms-data` に永続化する。

```bash
cp .env.example .env
# .env を編集し SESSION_SIGNING_KEYS を設定する(未設定だと web は起動を中断する):
#   openssl rand -base64 32   # 出力を {"k1":"<ここ>"} に入れる
docker compose up --build
```

- web UI: `http://localhost:8788`(ホスト側ポートは `.env` の `TMS_HOST_PORT` で変更可。コンテナ内は常に 8788)。
- 初回アクセスは `/setup`(「初期セットアップ」参照)。マイグレーションは起動時に自動適用される。
- `maintenance` サービスは `MAINTENANCE_INTERVAL_SECONDS`(既定 3600 = 1時間)毎に観測パージ・失効 sweep・
  `incremental_vacuum` を実行する(`SESSION_SIGNING_KEYS` は読まない — C10/C11)。

| 操作 | コマンド |
|---|---|
| 起動(ビルド込み) | `docker compose up --build` |
| バックグラウンド起動 | `docker compose up --build -d` |
| ログ確認 | `docker compose logs -f web` / `docker compose logs -f maintenance` |
| 停止 | `docker compose down` |
| 停止 + データ削除 | `docker compose down -v`(名前付きボリューム `tms-data` を削除) |
| 受け入れスモーク(空ボリューム時) | `./scripts/docker-smoke.sh` |

環境変数の意味は「環境変数一覧」を参照。`.env` は `.gitignore` 済み(コミットしない)。bind mount を使う場合は
ホスト側ディレクトリの所有権が非root `node`(uid 1000)で書ける必要がある(既定の名前付きボリュームでは不要)。

## 初期セットアップ

Organization が 0 件の状態でどのページにアクセスしても `/setup` に自動リダイレクトされる。ブラウザで `/setup` を開き、組織名・管理者メールアドレス・パスワード・表示名を入力して送信すると、組織と最初の管理者ユーザーが作成され `/login` にリダイレクトされる。以後、`/setup` へのアクセスは `/login` にリダイレクトされ、`POST /api/v1/setup` は `409 SETUP_ALREADY_COMPLETE` を返す(一度きりの操作)。

## 衛星同期クイックスタート(curl)

セットアップ・ログイン・プロジェクト作成・トークン発行・同期(start → chunk → commit)を curl だけで一通り試す例(`$B` はベース URL。`wrangler dev` ならローカルの `http://localhost:8787`、`npm run start:node` なら `http://localhost:8788` 等)。詳細なプロトコル仕様は [docs/sync-protocol.md](docs/sync-protocol.md) を参照。

```bash
B=http://localhost:8787

# 1. 初期セットアップ(初回のみ)
curl -s -X POST $B/api/v1/setup -H 'content-type: application/json' \
  -d '{"organization_name":"Org","admin_email":"a@example.com","admin_password":"password1","admin_display_name":"Admin"}'

# 2. ログイン(セッション Cookie + CSRF Cookie を jar に保存)
curl -s -c /tmp/jar -X POST $B/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"a@example.com","password":"password1"}'
CSRF=$(awk '$6=="csrf"{print $7}' /tmp/jar)

# 3. プロジェクト作成
PID=$(curl -s -b /tmp/jar -H "x-csrf-token: $CSRF" -X POST $B/api/v1/projects \
  -H 'content-type: application/json' -d '{"name":"payment"}' | jq -r .id)

# 4. 衛星向け API トークン発行(平文はこの応答でのみ取得できる)
TOKEN=$(curl -s -b /tmp/jar -H "x-csrf-token: $CSRF" -X POST $B/api/v1/projects/$PID/tokens \
  -H 'content-type: application/json' -d '{"name":"discovery-ci"}' | jq -r .token)

# 5. 同期セッション開始
SYN=$(curl -s -H "authorization: Bearer $TOKEN" -X POST $B/api/v1/projects/$PID/sync/start \
  -H 'content-type: application/json' -d '{"origin":"discovery-v1"}' | jq -r .sync_token)

# 6. 観測を送信(chunk。変化点のみ記録される)
curl -s -H "authorization: Bearer $TOKEN" -X POST $B/api/v1/projects/$PID/sync/$SYN/chunk \
  -H 'content-type: application/json' -d '{"observations":[{"external_ref":"com.example.T#m","fingerprint":"fp1",
  "observed":{"title":"支払いが成功する","given":"残高がある","when":"支払う","then":"成功する","parameters":[],"source_ref":{},"schema_version":"1.0"}}]}'

# 7. 確定(冪等。応答が more:true の間は同一トークンで再送する)
curl -s -H "authorization: Bearer $TOKEN" -X POST $B/api/v1/projects/$PID/sync/$SYN/commit

# 8. 同期サマリー確認(D-01)
curl -s -b /tmp/jar "$B/api/v1/projects/$PID/sync/status"
```
