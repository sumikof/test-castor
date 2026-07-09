# docker-compose オンプレ配布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 既存の on-prem Node エントリ(`start:node`)を、`web` + `maintenance` の2サービスからなる docker-compose で本番相当に起動できるようにする。

**Architecture:** マルチステージの非root イメージ(builder で `npm ci` + better-sqlite3 ネイティブビルド、runtime はスリム)を1つ作り、`web`(HTTP)と `maintenance`(定期パージ/vacuum ループ)が同一イメージ・同一 SQLite ボリュームを共有する。TS は既存の `node-ts-loader.mjs` で実行時変換する(ビルド工程を足さない)。署名鍵は compose の `${VAR:?}` 補間で必須化し、アプリのコードは(busy_timeout 1行を除き)変更しない。

**Tech Stack:** Docker(multi-stage, `node:22-bookworm-slim`)/ docker-compose / better-sqlite3 / @hono/node-server。npm 依存の追加は無し(GC-7)。

## Global Constraints

以下はスペック `docs/superpowers/specs/2026-07-08-docker-compose-design.md`(DC-01〜DC-08)由来の全タスク共通制約。各タスクの要求に暗黙で含まれる。

- **ベースは `node:22-bookworm-slim`**(better-sqlite3 は node22 ABI。builder/runtime で同一 base = glibc/arch 一致)。
- **npm 依存を新規追加しない**(GC-7)。Docker 化はインフラファイルの追加が主で、`src/` 変更は DC-07 の busy_timeout 1行のみ。
- **ローダを維持し、TS をプリコンパイルしない**(DC-01)。実行コマンドは `node --enable-source-maps --import ./src/entry/node-ts-loader.mjs <entry>`。イメージには実行時必須の `typescript`(devDep)を含める(素の `--omit=dev` 禁止)。
- **`maintenance` は `SESSION_SIGNING_KEYS` を要求しない**(C10/C11。参照 env は `TMS_DB_PATH` と `OBSERVATION_RETENTION_MS` のみ)。compose の `${SESSION_SIGNING_KEYS:?}` 必須化は `web` のみに適用する。
- **busy_timeout の発行位置**は `foreign_keys = ON` の直後・`auto_vacuum`/WAL 設定より前(auto_vacuum→WAL の順序制約とは独立。HANDOVER §5-8)。
- **コンテナ内ポートは常に 8788 に固定**。ホスト公開ポートのみ `${TMS_HOST_PORT:-8788}` で可変。
- **Conventional Commits**(feat:/fix:/test:/docs:/chore:)。コミット末尾に既定のトレーラ2行(Co-Authored-By / Claude-Session)を付す。
- **この作業環境に Docker は無い**。`docker build` / `docker compose up` を要する検証は「Deferred Acceptance」節に集約し、Docker のある環境で実施する。各タスクでは Docker 不要の静的検証(vitest / typecheck / YAML パース / `git check-ignore` / `bash -n`)を行う。
- 全コマンドは node22 を使うため `export PATH="$HOME/node22/bin:$PATH" &&` を前置する(この環境の Claude bash シェルは既定 node18。ユーザのログインシェルは node22)。

---

### Task 1: better-sqlite3 に busy_timeout を追加(DC-07)

**Files:**
- Modify: `src/storage/adapters/better-sqlite3.ts:8-9`(`foreign_keys = ON` の直後に1行追加)
- Test: `tests/contract/better-sqlite3-file.test.ts`(既存 describe に `it` を追加)

**Interfaces:**
- Consumes: `createBetterSqlite3Storage(path)` の戻り値 `{ storage, rawExec, sqlite }`(既存。`sqlite` は better-sqlite3 の `Database` インスタンス)。
- Produces: 実行時挙動のみ(接続の `busy_timeout` が 5000ms)。他タスクが参照する新規シンボルは無い。

- [ ] **Step 1: 失敗するテストを書く**

`tests/contract/better-sqlite3-file.test.ts` の `describe('better-sqlite3 adapter (file-backed)', () => { ... })` ブロック内、既存 `it(...)` の後に以下を追加する:

```ts
  it('sets busy_timeout so concurrent writers wait instead of erroring (DC-07)', () => {
    // web + maintenance が同一 SQLite に並行書込みするため、ロック競合を待って
    // SQLITE_BUSY を吸収する。busy_timeout は接続単位(ファイルに永続しない)ため、
    // 構築が返した接続そのもので検証する — probe 接続では観測できない。
    const { sqlite } = createBetterSqlite3Storage(path.join(dir, 'tms-busy.sqlite'));
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    sqlite.close();
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `export PATH="$HOME/node22/bin:$PATH" && npx vitest run --config vitest.config.ts tests/contract/better-sqlite3-file.test.ts -t "busy_timeout"`
Expected: FAIL(`expected 0 to be 5000` — 既定 busy_timeout は 0)。

- [ ] **Step 3: 最小実装**

`src/storage/adapters/better-sqlite3.ts` の

```ts
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
```

を以下に変更する(`foreign_keys` の直後に1行、`auto_vacuum` ブロックより前):

```ts
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  // DC-07: web + maintenance が同一 SQLite(WAL)へ並行書込みするため、ロック競合を最大5秒
  // 待って SQLITE_BUSY を吸収する。busy_timeout は接続単位の設定で、auto_vacuum→WAL の
  // 順序制約(operations.md §4.3)とは独立なので DB オープン直後に発行する。
  sqlite.pragma('busy_timeout = 5000');
```

- [ ] **Step 4: テストが通ることを確認**

Run: `export PATH="$HOME/node22/bin:$PATH" && npx vitest run --config vitest.config.ts tests/contract/better-sqlite3-file.test.ts -t "busy_timeout"`
Expected: PASS(1 passed)。

- [ ] **Step 5: 回帰・型チェック(既存を壊していないこと)**

Run: `export PATH="$HOME/node22/bin:$PATH" && npm run typecheck && npx vitest run --config vitest.config.ts tests/contract/better-sqlite3-file.test.ts`
Expected: typecheck 0 エラー、当該ファイルの全 `it` が PASS。

- [ ] **Step 6: コミット**

```bash
cd /workspace/.claude/worktrees/tms-mvp-build
git add src/storage/adapters/better-sqlite3.ts tests/contract/better-sqlite3-file.test.ts
git commit -m "$(cat <<'EOF'
feat: set better-sqlite3 busy_timeout=5000 for concurrent web+maintenance writers (DC-07)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015TahhmjE1z4whpHVrm4ukv
EOF
)"
```

---

### Task 2: .env.example と .gitignore(.env 除外)

**Files:**
- Create: `.env.example`
- Modify: `.gitignore`(末尾に `.env` を追加)

**Interfaces:**
- Produces: `.env`(コミットされない)が供給する env 変数群 — `SESSION_SIGNING_KEYS`(必須)、`TMS_HOST_PORT`、`MAINTENANCE_INTERVAL_SECONDS`、および任意上書き。Task 4(compose.yaml)がこれらを `env_file` と `${...}` 補間で消費する。

- [ ] **Step 1: .env.example を作成**

`.env.example`:

```bash
# TMS docker-compose 環境変数。`.env` にコピーして SESSION_SIGNING_KEYS を設定する:
#   cp .env.example .env
# `.env` は .gitignore 済み(コミットしない)。値の意味は README「環境変数一覧」を正とする。

# ===== 必須 =====
# セッション署名鍵。JSON {"<keyId>":"<secret>"}(keyId は数字のみ禁止)。
# 秘密の生成:  openssl rand -base64 32
# 例(この値は使い回さないこと):
#   SESSION_SIGNING_KEYS={"k1":"REPLACE_WITH_openssl_rand_base64_32_OUTPUT"}
# 未設定/空のまま `docker compose up` すると web は起動を中断する(必須化)。
SESSION_SIGNING_KEYS=

# ===== 任意(未設定なら安全な既定値。README のテーブル参照) =====
# web UI を公開するホスト側ポート(コンテナ内は常に 8788)。
TMS_HOST_PORT=8788
# maintenance サービスの実行間隔(秒。既定 3600 = 1時間 = CF cron と同義)。
MAINTENANCE_INTERVAL_SECONDS=3600

# 複数鍵ローテーション時のみ必須(単一鍵なら不要)。
# SESSION_ACTIVE_KEY_ID=k1
# SESSION_TTL_MS=604800000
# PBKDF2_ITERATIONS=600000
# LOGIN_RATE_LIMIT_WINDOW_MS=900000
# LOGIN_RATE_LIMIT_MAX=5
# SYNC_RATE_LIMIT_WINDOW_MS=60000
# SYNC_RATE_LIMIT_MAX=120
# OBSERVATION_RETENTION_MS=7776000000
# IDENTITY_TTL_MS=7776000000
# SYNC_COMMIT_WINDOW_LIMIT=500
```

- [ ] **Step 2: .gitignore に .env を追加**

`.gitignore` の末尾に以下を追加する(既存の `*.sqlite` 等は残す):

```gitignore
# docker-compose のローカル秘密(コミットしない。雛形は .env.example)
.env
```

- [ ] **Step 3: 検証(.env が無視され、.env.example は追跡対象)**

Run:
```bash
cd /workspace/.claude/worktrees/tms-mvp-build
printf 'SESSION_SIGNING_KEYS={"k1":"x"}\n' > .env
git check-ignore .env && echo "IGNORED_OK"
git check-ignore .env.example || echo "EXAMPLE_TRACKED_OK"
rm -f .env
```
Expected: `.env`(出力される = 無視対象)+ `IGNORED_OK`、`.env.example` は check-ignore が非0で `EXAMPLE_TRACKED_OK`。

- [ ] **Step 4: コミット**

```bash
cd /workspace/.claude/worktrees/tms-mvp-build
git add .env.example .gitignore
git commit -m "$(cat <<'EOF'
chore: add .env.example and gitignore .env for docker-compose (DC-08)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015TahhmjE1z4whpHVrm4ukv
EOF
)"
```

---

### Task 3: Dockerfile と .dockerignore(マルチステージ・非root イメージ)

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: リポジトリ内の `package.json` / `package-lock.json` / `src` / `public`(app.css・logo.svg)/ `migrations` / `tsconfig.json`。
- Produces: `runtime` ステージ(= イメージ)。`WORKDIR /app`、非root `node`、`EXPOSE 8788`、`VOLUME /data`、`ENV TMS_DB_PATH=/data/tms.sqlite PORT=8788`、`CMD` は `node ... src/entry/node.ts`。Task 4 がこのステージを `build.target: runtime` でビルドし `image: tms-web:local` として使う。

- [ ] **Step 1: .dockerignore を作成**

`.dockerignore`:

```gitignore
.git
node_modules
.wrangler
dist
*.sqlite
*.sqlite-*
.env
.env.*
public/htmx.min.js
tests
docs
.claude
.superpowers
*.md
Dockerfile
compose.yaml
.dockerignore
```

(`node_modules` はイメージ内で再インストール、`public/htmx.min.js` は postinstall が生成するため除外。`src`・`public/app.css`・`public/logo.svg`・`migrations`・`tsconfig.json`・`package*.json` は除外していないのでビルドコンテキストに入る。)

- [ ] **Step 2: Dockerfile を作成**

`Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

# ---- builder: 依存インストール + better-sqlite3 ネイティブビルド + postinstall(htmx) ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
# better-sqlite3 のネイティブビルド用ツールチェーン(prebuilt が無い場合の node-gyp フォールバック)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
# postinstall が public/ へ htmx を書くため、npm ci の前に public/ を存在させる。
# package ファイル先行 COPY で依存レイヤをキャッシュする。
COPY package.json package-lock.json ./
RUN mkdir -p public && npm ci
# アプリのソース一式(public/app.css・logo.svg、src、migrations、tsconfig)を投入。
# .dockerignore により node_modules と public/htmx.min.js は上書きされない。
COPY . .

# ---- runtime: スリム・非root・ビルドツール無し ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# 永続 SQLite の置き場。組み込みの非root ユーザ `node`(uid 1000)が書けるようにする。
# named volume は初回作成時にこのマウントポイントの所有権を継承する。
RUN mkdir -p /data && chown node:node /data
# builder の依存ツリー(コンパイル済み better-sqlite3 + 実行時に必要な typescript を含む)と
# アプリ資産を、非root 所有でコピーする。
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/migrations ./migrations
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=node:node /app/package.json ./package.json
USER node
ENV TMS_DB_PATH=/data/tms.sqlite \
    PORT=8788
EXPOSE 8788
VOLUME ["/data"]
# ヘルスチェック: /app.css は setup/auth 状態に依らず 200 の静的ファイル。curl 不要(Node 内蔵 fetch)。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||8788;fetch('http://127.0.0.1:'+p+'/app.css').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec 形式 → SIGTERM が node に直接届く。
CMD ["node","--enable-source-maps","--import","./src/entry/node-ts-loader.mjs","src/entry/node.ts"]
```

- [ ] **Step 3: 静的検証(Docker 不要の範囲)**

Run:
```bash
cd /workspace/.claude/worktrees/tms-mvp-build
grep -q 'AS builder' Dockerfile && grep -q 'AS runtime' Dockerfile && echo "MULTISTAGE_OK"
grep -q 'USER node' Dockerfile && echo "NONROOT_OK"
grep -q 'node-ts-loader.mjs' Dockerfile && echo "LOADER_OK"
grep -qx 'node_modules' .dockerignore && echo "IGNORE_NODE_MODULES_OK"
```
Expected: `MULTISTAGE_OK` / `NONROOT_OK` / `LOADER_OK` / `IGNORE_NODE_MODULES_OK` が全て出力される。
Note: 実際の `docker build` は Docker のある環境で(Deferred Acceptance A)。

- [ ] **Step 4: コミット**

```bash
cd /workspace/.claude/worktrees/tms-mvp-build
git add Dockerfile .dockerignore
git commit -m "$(cat <<'EOF'
feat: add multi-stage non-root Dockerfile for on-prem node entry (DC-02)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015TahhmjE1z4whpHVrm4ukv
EOF
)"
```

---

### Task 4: compose.yaml(web + maintenance の2サービス)

**Files:**
- Create: `compose.yaml`

**Interfaces:**
- Consumes: Task 3 の `runtime` ステージ(`build.target: runtime`、`image: tms-web:local`)、Task 2 の `.env`(`env_file` + `${...}` 補間)。
- Produces: サービス `web`(`${TMS_HOST_PORT:-8788}:8788`)/ `maintenance`(ループ実行)、named volume `tms-data`。

- [ ] **Step 1: compose.yaml を作成**

`compose.yaml`:

```yaml
name: tms

# web と maintenance は同一イメージ・同一ビルド。DRY のため anchor で共有する。
x-tms-build: &tms-build
  context: .
  target: runtime

services:
  web:
    build: *tms-build
    image: tms-web:local
    restart: unless-stopped
    ports:
      - "${TMS_HOST_PORT:-8788}:8788"
    environment:
      # 必須。未設定/空なら compose が `up` を中断する(本番相当の必須化・DC-04)。
      SESSION_SIGNING_KEYS: "${SESSION_SIGNING_KEYS:?SESSION_SIGNING_KEYS must be set in .env (see .env.example)}"
      TMS_DB_PATH: /data/tms.sqlite
      PORT: "8788"
    env_file:
      - .env
    volumes:
      - tms-data:/data

  maintenance:
    build: *tms-build
    image: tms-web:local
    restart: unless-stopped
    environment:
      TMS_DB_PATH: /data/tms.sqlite
    env_file:
      - .env
    volumes:
      - tms-data:/data
    # maintenance-cli は署名鍵を読まない(C10/C11)。1回実行 → 間隔 sleep のループ。
    # `$$` は compose 補間を避け、コンテナ内シェルに ${...} をそのまま渡すためのエスケープ。
    command:
      - sh
      - -c
      - |
        while true; do
          node --enable-source-maps --import ./src/entry/node-ts-loader.mjs src/entry/maintenance-cli.ts || echo "maintenance run failed (exit $$?)"
          sleep "$${MAINTENANCE_INTERVAL_SECONDS:-3600}"
        done

volumes:
  tms-data:
```

- [ ] **Step 2: 静的検証(YAML パース + 構造アサート・Docker 不要)**

Run:
```bash
cd /workspace/.claude/worktrees/tms-mvp-build
export PATH="$HOME/node22/bin:$PATH"
node -e "
const YAML=require('yaml');
const fs=require('fs');
const d=YAML.parse(fs.readFileSync('compose.yaml','utf8'));
const s=d.services;
if(!s.web||!s.maintenance) throw new Error('2 services required');
if(!String(s.web.environment.SESSION_SIGNING_KEYS).includes(':?')) throw new Error('web must enforce SESSION_SIGNING_KEYS');
if(s.maintenance.environment&&s.maintenance.environment.SESSION_SIGNING_KEYS) throw new Error('maintenance must NOT require signing keys');
if(!d.volumes||!('tms-data' in d.volumes)) throw new Error('tms-data volume required');
console.log('COMPOSE_STRUCTURE_OK');
"
```
Expected: `COMPOSE_STRUCTURE_OK`(パース成功 + web が `:?` で鍵必須化 + maintenance は鍵を要求しない + `tms-data` volume 定義あり)。
Note: `docker compose config` / `up` は Docker のある環境で(Deferred Acceptance)。

- [ ] **Step 3: コミット**

```bash
cd /workspace/.claude/worktrees/tms-mvp-build
git add compose.yaml
git commit -m "$(cat <<'EOF'
feat: add compose.yaml with web + maintenance services (DC-03/DC-04)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015TahhmjE1z4whpHVrm4ukv
EOF
)"
```

---

### Task 5: スモークスクリプトと README の Docker セクション

**Files:**
- Create: `scripts/docker-smoke.sh`
- Modify: `README.md`(「オンプレ起動」節の後に「Docker / docker-compose 起動」節を追加)

**Interfaces:**
- Consumes: 稼働中の web サービス(既定 `http://localhost:8788`)。`jq` を使用。
- Produces: 受け入れ確認スクリプト(setup→login→project→token→sync、`testcase_count` 増加を assert)。

- [ ] **Step 1: scripts/docker-smoke.sh を作成**

`scripts/docker-smoke.sh`(**空のボリュームで起動した web に対して**実行する受け入れスモーク):

```bash
#!/usr/bin/env bash
# TMS docker-compose 受け入れスモーク。空ボリュームで `docker compose up` した web に対して実行する。
# 使い方:  ./scripts/docker-smoke.sh [BASE_URL]   (既定 http://localhost:8788)
set -euo pipefail
B="${1:-http://localhost:8788}"
jar="$(mktemp)"; trap 'rm -f "$jar"' EXIT
say(){ printf '\n=== %s ===\n' "$1"; }

say "1. setup (組織+管理者を作成)"
code=$(curl -s -o /tmp/tms-setup.json -w '%{http_code}' -X POST "$B/api/v1/setup" \
  -H 'content-type: application/json' \
  -d '{"organization_name":"Org","admin_email":"a@example.com","admin_password":"password1","admin_display_name":"Admin"}')
[ "$code" = "201" ] || { echo "setup expected 201, got $code"; cat /tmp/tms-setup.json; exit 1; }

say "2. login (cookie jar 保存)"
curl -s -c "$jar" -X POST "$B/api/v1/auth/login" -H 'content-type: application/json' \
  -d '{"email":"a@example.com","password":"password1"}' >/dev/null
CSRF=$(awk '$6=="csrf"{print $7}' "$jar")
[ -n "$CSRF" ] || { echo "no csrf cookie"; exit 1; }

say "3. create project"
PID=$(curl -s -b "$jar" -H "x-csrf-token: $CSRF" -X POST "$B/api/v1/projects" \
  -H 'content-type: application/json' -d '{"name":"payment"}' | jq -r .id)
[ "$PID" != "null" ] && [ -n "$PID" ] || { echo "project create failed"; exit 1; }

say "4. issue satellite token"
TOKEN=$(curl -s -b "$jar" -H "x-csrf-token: $CSRF" -X POST "$B/api/v1/projects/$PID/tokens" \
  -H 'content-type: application/json' -d '{"name":"discovery-ci"}' | jq -r .token)
[ "$TOKEN" != "null" ] && [ -n "$TOKEN" ] || { echo "token issue failed"; exit 1; }

say "5-7. sync start / chunk / commit"
SYN=$(curl -s -H "authorization: Bearer $TOKEN" -X POST "$B/api/v1/projects/$PID/sync/start" \
  -H 'content-type: application/json' -d '{"origin":"discovery-v1"}' | jq -r .sync_token)
curl -s -H "authorization: Bearer $TOKEN" -X POST "$B/api/v1/projects/$PID/sync/$SYN/chunk" \
  -H 'content-type: application/json' \
  -d '{"observations":[{"external_ref":"com.example.T#m","fingerprint":"fp1","observed":{"title":"支払い成功","given":"残高あり","when":"支払う","then":"成功","parameters":[],"source_ref":{},"schema_version":"1.0"}}]}' >/dev/null
curl -s -H "authorization: Bearer $TOKEN" -X POST "$B/api/v1/projects/$PID/sync/$SYN/commit" >/dev/null

say "8. testcase_count が 1 に増えていること"
COUNT=$(curl -s -b "$jar" "$B/api/v1/projects" | jq '.items[0].testcase_count')
[ "$COUNT" = "1" ] || { echo "expected testcase_count 1, got $COUNT"; exit 1; }

echo -e "\nSMOKE OK: setup→login→project→token→sync→count=1 すべて成功"
```

- [ ] **Step 2: スクリプトを実行可能にし、構文検証(Docker 不要)**

Run:
```bash
cd /workspace/.claude/worktrees/tms-mvp-build
chmod +x scripts/docker-smoke.sh
bash -n scripts/docker-smoke.sh && echo "BASH_SYNTAX_OK"
```
Expected: `BASH_SYNTAX_OK`(構文エラー無し)。実際の HTTP 実行は Deferred Acceptance C で。

- [ ] **Step 3: README に Docker セクションを追加**

`README.md` の「### メンテナンス(OS cron)」節の**直後**、「## 初期セットアップ」の**直前**に以下を挿入する:

````markdown
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
````

- [ ] **Step 4: README の内部整合を確認(Docker 不要)**

Run:
```bash
cd /workspace/.claude/worktrees/tms-mvp-build
grep -q '## Docker / docker-compose 起動' README.md && echo "README_SECTION_OK"
grep -q 'docker compose up --build' README.md && echo "README_CMD_OK"
```
Expected: `README_SECTION_OK` / `README_CMD_OK`。

- [ ] **Step 5: コミット**

```bash
cd /workspace/.claude/worktrees/tms-mvp-build
git add scripts/docker-smoke.sh README.md
git commit -m "$(cat <<'EOF'
docs: add docker-compose usage to README + acceptance smoke script (DC-08)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015TahhmjE1z4whpHVrm4ukv
EOF
)"
```

---

## 最終検証(全タスク後・Docker 不要の範囲)

- [ ] **typecheck + フルスイート**: `export PATH="$HOME/node22/bin:$PATH" && npm run typecheck && npm test`
  Expected: typecheck 0 エラー、`test:unit` 417 passed(既存 416 + busy_timeout 1)、`test:workers` 399 passed。
- [ ] **git 状態**: `git status --short` がクリーン(追跡外の `.env` / `tms.sqlite` を残していないこと)。

## Deferred Acceptance(Docker のある環境で実施)

この作業環境には Docker が無いため、以下はスペックの受け入れ基準として Docker のある環境(開発者の手元)で実施する。中身の `start:node` E2E はブレインストーミング中に実証済み。

- **A. ビルド + 起動**: `cp .env.example .env` して `SESSION_SIGNING_KEYS` を設定 → `docker compose up --build` → `docker compose ps` で web が `healthy`。
- **B. maintenance**: `docker compose logs maintenance` に `runMaintenance` の実行 JSON が出る。
- **C. E2E スモーク**: `./scripts/docker-smoke.sh` が `SMOKE OK` で終了(setup→login→project→token→sync、`testcase_count=1`)。
- **D. 永続化**: スモーク後 `docker compose restart web` → 再度 `GET /api/v1/projects` で `testcase_count=1` が残る。
- **E. 必須化**: `.env` の `SESSION_SIGNING_KEYS` を空にして `docker compose up` → 起動が中断メッセージで止まる。
- **F. 非root**: `docker compose exec web id` が `uid=1000(node)` を返す。

## Self-Review(記入済み)

- **Spec coverage**: DC-01(Task 3 CMD=ローダ)/ DC-02(Task 3)/ DC-03(Task 4 2サービス)/ DC-04(Task 4 `:?`)/ DC-05(自動マイグレーション=既存挙動、追加サービス無しで充足)/ DC-06(Task 3 `/data` 所有権 + Task 4 volume)/ DC-07(Task 1)/ DC-08(Task 2 + Task 3 .dockerignore + Task 5 README)。全 DC に対応タスクあり。
- **Placeholder scan**: 全コード/ファイル内容は実体を記載。`REPLACE_WITH_...` は .env.example の意図的な指示placeholderで、コミットする雛形の一部。
- **Type consistency**: `createBetterSqlite3Storage` の戻り `{ sqlite }`、`pragma('busy_timeout',{simple:true})`、compose の `image: tms-web:local` / `build.target: runtime`、`TMS_DB_PATH=/data/tms.sqlite`、コンテナ内 `PORT=8788` はタスク間で一致。
