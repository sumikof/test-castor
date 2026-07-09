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
