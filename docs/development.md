# 開発・ローカル実行・テストガイド

ローカルで TMS を動かし、テストする手順をまとめる。設計の正本は `docs/` の各ドキュメント、
運用（パージ/cron 等）は [operations.md](operations.md)、起動時の env 詳細は [README](../README.md) を参照。

## 1. 前提環境

- **Node.js v22 必須。** ネイティブ依存 `better-sqlite3` は node22 の ABI 向けにビルドされる。
  node18 等で実行すると `NODE_MODULE_VERSION` 不一致で `npm run start:node` や better-sqlite3 契約テストが失敗する。
- **PATH の注意点:** 通常のログインシェル（`.zshenv` / `.profile` / `.bashrc` が node22 を前置）では
  node22 が既定になる。もし `node --version` が v18 等を返す環境（非ログインシェル、一部の CI / 自動実行）では、
  コマンドの前に次を前置する:

  ```bash
  export PATH="$HOME/node22/bin:$PATH"
  node --version   # v22.x を確認
  ```

## 2. セットアップ

```bash
npm install
```

`postinstall` が `htmx.org` の `htmx.min.js` を `public/` にコピーする（`public/htmx.min.js` は生成物で gitignore 済み）。

## 3. テストの実行

| コマンド | 内容 | 実行基盤 |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit`（型エラー 0 が基準） | — |
| `npm run test:unit` | 単体テスト + better-sqlite3 / libSQL 契約テスト（**416 tests**） | Vitest node pool（`vitest.config.ts`） |
| `npm run test:workers` | 統合テスト + D1 契約テスト（**399 tests**） | Vitest workers pool（`@cloudflare/vitest-pool-workers`） |
| `npm test` | `test:unit` → `test:workers` を順に実行（**合計 815 tests green が基準**） | 両 pool |

- **単一ファイル / 名前で絞り込み**（node pool の例）:

  ```bash
  npx vitest run --config vitest.config.ts tests/contract/better-sqlite3-file.test.ts -t "busy_timeout"
  ```

- `test:workers` では、インストール済み workerd の compatibility date 上限に関する警告が出ることがあるが**無害**。

## 4. ローカル起動（3 経路）

| 経路 | コマンド | ポート | バックエンド | 永続化 | マイグレーション | 主な用途 |
|---|---|---|---|---|---|---|
| **Workers エミュレーション** | `npm run dev` | 8787 | D1（workerd / miniflare） | `.wrangler/` の local state | **手動**（下記） | 本番（Cloudflare）に最も近い検証 |
| **オンプレ Node** | `npm run start:node` | 8788 | better-sqlite3（ファイル） | `TMS_DB_PATH` のファイル | **起動時に自動適用** | 自己完結の手軽な起動 |
| **Docker Compose** | `docker compose up --build` | 8788 | better-sqlite3（ファイル） | named volume `tms-data` | **起動時に自動適用** | 本番相当オンプレ配布 |

初期状態（Organization 0 件）ではどのページも `/setup` にリダイレクトされる。ブラウザで `/setup` を開いて
組織・管理者を作成する（[README 初期セットアップ](../README.md) 参照）。

### 4a. Workers エミュレーション（`npm run dev`）

```bash
# 初回、またはマイグレーション追加後は local D1 にスキーマを適用する
npx wrangler d1 migrations apply tms --local
npm run dev            # http://localhost:8787
```

`wrangler dev` は D1 / ASSETS バインディングを local mode で提供する（`wrangler.jsonc`）。`scheduled`（cron）は
local では自動発火しないため、必要なら `curl "http://localhost:8787/cdn-cgi/handler/scheduled"` で手動起動する。

### 4b. オンプレ Node（`npm run start:node`）

```bash
TMS_DB_PATH=./tms.sqlite PORT=8788 npm run start:node   # http://localhost:8788
```

better-sqlite3 アダプタが起動時に `migrations/` を自動適用するため、別途マイグレーション操作は不要。
env 一覧（`SESSION_SIGNING_KEYS` 等）は [README 環境変数一覧](../README.md) を参照（未設定時は開発用フォールバック鍵で起動し警告を出す）。
オンプレのメンテナンス（観測パージ・sweep・`incremental_vacuum`）は `TMS_DB_PATH=./tms.sqlite npm run maintenance:node` を単発実行する。

### 4c. Docker Compose（`docker compose up --build`）

`web`（HTTP）+ `maintenance`（定期メンテナンス）の 2 サービス。詳細は [README Docker / docker-compose 起動](../README.md) と
設計 [docs/superpowers/specs/2026-07-08-docker-compose-design.md](superpowers/specs/2026-07-08-docker-compose-design.md) を参照。

```bash
cp .env.example .env
# .env の SESSION_SIGNING_KEYS を設定（未設定だと web は起動を中断する）
#   openssl rand -base64 32   # 出力を {"k1":"<ここ>"} に入れる
docker compose up --build      # http://localhost:8788（ホスト側ポートは .env の TMS_HOST_PORT で変更可）
```

## 5. 動作確認（手動 E2E）

- **curl ウォークスルー**（setup → login → project → token 発行 → sync start/chunk/commit → status）:
  [README 衛星同期クイックスタート](../README.md) を参照。ベース URL は経路に合わせる（`npm run dev`＝8787、
  `start:node` / Docker＝8788）。
- **Docker 受け入れスモーク**（空ボリューム時）:

  ```bash
  ./scripts/docker-smoke.sh                    # 既定 http://localhost:8788
  ./scripts/docker-smoke.sh http://localhost:8788
  ```

  `SMOKE OK` で終了すれば setup→login→project→token→sync→`testcase_count=1` まで通っている。

## 6. トラブルシュート

| 症状 | 対処 |
|---|---|
| `node --version` が v18 等になる | `export PATH="$HOME/node22/bin:$PATH"` を前置（§1） |
| `NODE_MODULE_VERSION` 不一致 / better-sqlite3 が読めない | node22 で `npm rebuild better-sqlite3`、または node22 で `npm install` し直す |
| `npm run dev` で D1 の "no such table" | `npx wrangler d1 migrations apply tms --local` を実行 |
| ポート競合（8787 / 8788） | 既存プロセスを停止するか、ポートを変える（Node は `PORT`、Compose は `.env` の `TMS_HOST_PORT`） |
| `docker compose up` が署名鍵エラーで中断 | `.env` に `SESSION_SIGNING_KEYS` を設定（本番相当の必須化・意図的挙動） |
| workerd の compatibility date 上限警告 | 無害。無視してよい |
