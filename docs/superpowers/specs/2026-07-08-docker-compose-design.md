# TMS docker-compose オンプレ配布 設計

日付: 2026-07-08
ステータス: 承認済み(ユーザー確認済み)

## 目的

既存の on-prem Node エントリ(`npm run start:node` = better-sqlite3 でファイル永続化する経路)を、**Docker / docker-compose で本番相当に起動できるようにする**。本スペックは (1) 構築スコープ、(2) 設計判断、(3) 追加/変更ファイル、(4) 検証方針 を記録する。アプリのランタイム挙動・env 変数の意味は既存の `README.md` / `docs/operations.md` を正とし、繰り返さない。

Cloudflare Workers 版(`wrangler dev` / `wrangler deploy`)は wrangler/workerd 前提の経路として**現状のまま残す**。本作業は既存の起動手段を置き換えず、Docker という配布・起動の選択肢を**純粋に追加**する。

## 前提・制約

- **この作業環境に Docker が無い**(`docker` コマンド・デーモン無し)。よって成果物の作成と静的自己レビューまでを行い、`docker compose up --build` の実地検証は Docker のある環境(開発者の手元)で行う。コンテナ内で動く中身(`start:node`)は、同一の env(`TMS_DB_PATH`/`PORT`/署名鍵)で本セッション中に E2E 実証済み(setup→login→project→token→sync)。
- このプロジェクトは**ビルド工程が無く**、TS を実行時に `src/entry/node-ts-loader.mjs`(内部で `typescript` の `transpileModule` を使用)で直接実行する。したがって **`typescript`(devDependency)は実行時に必須**。素朴な `npm ci --omit=dev` はローダを壊す(DC-01)。
- `package-lock.json` は存在する(`npm ci` 使用可)。`postinstall` は htmx を `public/` にコピーする(`public/` ディレクトリの存在が前提)。
- `tsconfig.json`: `moduleResolution:"Bundler"` / 拡張子なし相対 import / `jsx:"react-jsx"` + `jsxImportSource:"hono/jsx"` / `noEmit:true`。

## スコープ

### 実装対象

- **Dockerfile**: マルチステージ(`node:22-bookworm-slim`)、非root 実行、better-sqlite3 をイメージ内ビルド
- **compose.yaml**: `web` + `maintenance` の 2 サービス、1 イメージ共有、名前付きボリューム共有
- **.dockerignore** / **.env.example** / `.gitignore` へ `.env` 追加
- **README** に「Docker / docker-compose 起動」セクション追加
- スモーク検証スクリプト(受け入れ確認用)

### 対象外

- Cloudflare Workers 版のコンテナ化(wrangler/workerd 前提で compose に不適)
- レジストリへの push / Kubernetes 等オーケストレータ配備(手順・マニフェストは作らない)
- **イメージの devDeps プルーニング最適化**(ローダが `typescript` を実行時要求するため単純 `--omit=dev` 不可。将来課題として明記)
- **SIGTERM グレースフルシャットダウン**(`node.ts`。WAL リカバリで急停止も安全。将来課題)
- CI での自動 `docker build`(この環境に Docker 無し)

## 決定事項

### DC-01 実行モデル: ローダ維持(プリコンパイルしない)

コンテナ内でも今と同じく `node --enable-source-maps --import ./src/entry/node-ts-loader.mjs src/entry/node.ts` を実行する。イメージには実行時に必要な依存(`dependencies` + `optionalDependencies` の `better-sqlite3`/`@hono/node-server` + devDep の `typescript`)を含める。

- 却下案 A(tsc プリコンパイル): `moduleResolution:"Bundler"` + 拡張子なし import + `noEmit` のため、Node の素の ESM が `from '../http/config'` を解決できない。JSX(.tsx)変換も別途必要。**動かない**。
- 却下案 B(esbuild バンドル): 新ツール・新依存(GC-7「依存追加は意識的に」に抵触)。今回の目的に対し過剰。
- 帰結: 全 `node_modules` を同梱する分イメージは大きい(数百MB)が、オンプレ配布として許容。プルーニングは将来課題。

### DC-02 Dockerfile: マルチステージ / 非root / slim

- **builder** ステージ: `node:22-bookworm-slim` に `build-essential`・`python3` を入れ、`npm ci` を実行(better-sqlite3 をこのイメージのアーキ向けにネイティブビルド、`postinstall` で htmx を `public/` へ配置)。
- **runtime** ステージ: **同一 base**(glibc/アーキが一致し、builder でコンパイルした better-sqlite3 の `.node` が動く)。ビルドツールは持たないスリム構成。builder から `node_modules` / `src` / `public` / `migrations` / `tsconfig.json` / `package.json` をコピー。`WORKDIR /app`(`node.ts` の `serveStatic({root:'./public'})` が相対解決できるように)。非root(`USER node`)。`EXPOSE 8788`。`CMD` は node バイナリを**直接 exec 形式**で(`npm run` を挟まず、SIGTERM がプロセスへ届くように)。
- **HEALTHCHECK**: `/app.css`(セットアップ状態に依存せず常に 200 の静的ファイル)を **Node 内蔵 `fetch`** で叩く(スリムイメージに curl/wget を足さない)。
- 実装上の要点(計画で具体化): `postinstall` が `public/` へ書くため、**`npm ci` の前に `public/` ディレクトリが存在**する必要がある(`mkdir -p public` を先行させるか、`public/` を先に COPY)。`public/htmx.min.js` はビルド生成物として扱い、`.dockerignore` で除外してよい。

### DC-03 compose: 2 サービス・1 イメージ・共有ボリューム

| サービス | 内容 |
|---|---|
| **web** | `start:node` を起動。`ports: ${PORT:-8788}:8788`、`TMS_DB_PATH=/data/tms.sqlite`、`volumes: tms-data:/data`、`restart: unless-stopped` |
| **maintenance** | 同一イメージで `command` を差し替え、`maintenance-cli` 実行 → `sleep ${MAINTENANCE_INTERVAL_SECONDS:-3600}` のループ(既定 1 時間 = `wrangler.jsonc` の cron `0 * * * *` と同義)。`tms-data:/data` を共有。**署名鍵を読まない**(HANDOVER §3.2 の C10/C11 デカップリング。参照 env は `TMS_DB_PATH` と `OBSERVATION_RETENTION_MS` のみ)。`restart: unless-stopped` |

両サービスとも起動時に storage を構築するため、マイグレーションは自動適用される(DC-05)。

### DC-04 署名鍵の必須化(アプリ非改修)

`web` サービスで `SESSION_SIGNING_KEYS=${SESSION_SIGNING_KEYS:?set SESSION_SIGNING_KEYS in .env (JSON like {"k1":"<32+ char secret>"})}` を用いる。compose の変数補間 `${VAR:?err}` により、**未設定/空なら `docker compose up` が起動を中断**する。アプリ側の dev フォールバック挙動(`loadConfig`)は変更しない(=挙動不変・他の経路に影響なし)。`maintenance` は署名鍵を読まないため補間対象にしない。

### DC-05 マイグレーション: 自動(追加サービス不要)

`src/storage/adapters/better-sqlite3.ts` は storage 構築時に `migrationStatements()` を全適用する。web / maintenance のどちらの起動でもスキーマが揃うため、別途 migrate サービス・手順は不要。

### DC-06 永続化と権限

名前付きボリューム `tms-data` を `/data` にマウントし、`TMS_DB_PATH=/data/tms.sqlite`。イメージ内で `/data` を `node` ユーザ所有にしておく(名前付きボリュームは**初回作成時にイメージ側マウントポイントの所有権を継承**するため、非root でも書ける)。bind mount を使う場合はホスト側の所有権に依存する旨を README に注記。

### DC-07 SQLite 並行性: better-sqlite3 の既定 busy_timeout=5000 で充足(コード変更なし)

web と maintenance が**同一 SQLite ファイル(WAL)へ並行書込み**する。この並行性は README 記載の既存オンプレ運用(web サーバ + OS cron の maintenance-cli)にも既に存在する。

- **実行時(2026-07-09)の実測で判明**: `better-sqlite3` v12.11.1 は `new Database()` 時に `timeout` オプション(既定 5000)を `PRAGMA busy_timeout` として自動適用する。`createBetterSqlite3Storage` は明示設定していないが、接続の `busy_timeout` は既に 5000ms。→ 並行書込みのロック競合(`SQLITE_BUSY`)は**既定で最大 5 秒待って吸収済み**。
- 当初案(明示 `busy_timeout = 5000` の追加)は既定と同値の redundant no-op で、かつ revert-proof テスト不可(行を消しても 5000 のまま)。**ユーザ裁定によりコード変更しない**(既定に依拠)。この判断により Docker 化は `src/` 無改修の純粋な追加になる。
- 将来 better-sqlite3 の既定が変わる/より長い待ちが要る場合のみ、明示設定(必要なら別値 + 識別テスト)を検討。

### DC-08 .env / .env.example / .dockerignore

- **.env.example**(コミットする雛形): `SESSION_SIGNING_KEYS`(必須・生成例 `openssl rand -base64 32` → `{"k1":"<secret>"}` を併記)、`PORT`、`MAINTENANCE_INTERVAL_SECONDS`、および任意上書き(`SESSION_ACTIVE_KEY_ID` / `SESSION_TTL_MS` / `PBKDF2_ITERATIONS` / `LOGIN_RATE_LIMIT_*` / `SYNC_RATE_LIMIT_*` / `OBSERVATION_RETENTION_MS` / `IDENTITY_TTL_MS` / `SYNC_COMMIT_WINDOW_LIMIT`)。
- **.gitignore**: `.env` を追加(`*.sqlite` は既存で無視済み)。
- **.dockerignore**: `node_modules`・`.git`・`.wrangler`・`dist`・`*.sqlite*`・`tests`・`docs`・`.claude`・`.superpowers`・スクラッチ類を除外。`src`・`public`(`htmx.min.js` を除く)・`migrations`・`tsconfig.json`・`package.json`・`package-lock.json` は含める。

## ファイル変更一覧

- **追加**: `Dockerfile`、`compose.yaml`、`.dockerignore`、`.env.example`、`scripts/docker-smoke.sh`(受け入れ確認用の curl ウォークスルー)
- **変更**: `.gitignore`(`.env` 追加)、`README.md`(Docker セクション追加)。`src/` 変更は無し(DC-07 は既定で充足)

## 検証方針(受け入れ基準)

Docker のある環境で:

1. `cp .env.example .env` して `SESSION_SIGNING_KEYS` を設定 → `docker compose up --build` → **web が healthy** になる
2. **maintenance** がログに実行 JSON(`runMaintenance` の結果)を出す
3. `http://localhost:8788` に curl ウォークスルー(setup→login→project→token→sync/start・chunk・commit・status)が成功し、**`testcase_count` が増加**する
4. **永続化**: データ投入 → `docker compose restart web` → データが残る
5. **必須化**: `SESSION_SIGNING_KEYS` を空にすると `docker compose up` が中断メッセージで止まる
6. **回帰**: `npm test`(815)green、`npm run typecheck` 0 エラー(Docker 化は `src/` 無改修のため純増なし)

この作業環境で可能な代替検証(Docker 不要): (6) の vitest / typecheck は実行可能。(3) 相当の E2E は素の `start:node` で実施済み(本セッション)。Dockerfile/compose は静的レビューで correct-by-construction を担保。

## 未解決・リスク

- **Docker 実地未検証**(この環境の制約)。ファイルは静的レビュー + 中身の E2E 実証で担保するが、初回 `docker compose up` は開発者の手元での確認が必要。
- **イメージサイズ**: 全 `node_modules` 同梱で数百MB。将来プルーニング可能(DC-01)。
- **maintenance ループ**は単純 `sleep` ベースで厳密な cron ではない(用途上十分。停止中に取りこぼした回の catch-up はしない)。
