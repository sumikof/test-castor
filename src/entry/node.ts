// src/entry/node.ts
// task-23-brief.md「Node エントリ」。@hono/node-server + better-sqlite3 でオンプレ実行する、
// src/entry/workers.ts(CF)の対になるエントリ。AppDeps の組み立て方は workers.ts の buildDeps と
// 同じ形(loadConfig → storage/auth/rateLimiter → AppDeps)を踏襲するが、storage は D1 ではなく
// better-sqlite3(src/storage/adapters/better-sqlite3.ts)を使う。
//
// GC-6: このファイルは node 専用でよいが、CF 型(D1Database 等)は一切参照しない
// (@hono/node-server・better-sqlite3 のみに依存。workers.ts のような CF アンビエント型は不要)。
// GC-3: 実クロックを読むのは entry 層のみ(now = () => Date.now())。
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp, type AppDeps } from '../http/app';
import { loadConfig } from '../http/config';
import { createBetterSqlite3Storage } from '../storage/adapters/better-sqlite3';
import { createWebcryptoAuth } from '../auth/webcrypto-auth';
import { createMemoryRateLimiter } from '../ratelimit/memory';

/**
 * `dataPath`(既定は env `TMS_DB_PATH`、それも無ければ `./tms.sqlite`)を開き、AppDeps を組み立てて
 * createApp() する。静的配信(public/ 配下の app.css・htmx.min.js・logo.svg。postinstall で htmx を
 * コピー済み)は createApp() の全ルート登録より後に '/*' ミドルウェアとして追加する — Hono の compose は
 * 「該当したハンドラが next() を呼ばずに応答を返せばそこで完結する」規約のため、既存の API/UI ルートに
 * 一致したリクエストは serveStatic に到達せず、未マッチのリクエストだけが静的ファイル解決を試みる
 * (見つからなければ serveStatic が next() を呼び、createApp() の notFound → 統一エラースキーマ 404 に
 * フォールバックする)。
 *
 * listen はしない(呼び出し側 = main() の責務)。tests/unit/node-entry.test.ts は本関数を
 * `createNodeApp(':memory:')` として呼び、`app.request(...)` のみで検証する。
 */
export function createNodeApp(dataPath = process.env.TMS_DB_PATH ?? './tms.sqlite') {
  const config = loadConfig(process.env);
  const { storage } = createBetterSqlite3Storage(dataPath);
  const now = () => Date.now();
  const deps: AppDeps = {
    storage,
    auth: createWebcryptoAuth({
      signingKeys: config.signingKeys,
      activeKeyId: config.activeKeyId,
      pbkdf2Iterations: config.pbkdf2Iterations,
    }),
    config,
    now,
    loginLimiter: createMemoryRateLimiter(config.loginRateLimit, now),
    syncLimiter: createMemoryRateLimiter(config.syncRateLimit, now),
  };
  const app = createApp(deps);
  app.use('/*', serveStatic({ root: './public' })); // 未マッチのみ静的配信(上記コメント参照)
  return { app, deps };
}

function main(): void {
  const { app } = createNodeApp();
  const port = Number(process.env.PORT ?? 8788);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(JSON.stringify({ event: 'node_entry_listening', port: info.port }));
  });
}

// import.meta.main 相当のガード: このモジュールが直接実行された(`node src/entry/node.ts` 等)ときのみ
// listen する。テストからの import(vitest 経由)では import.meta.main が undefined(falsy)になるため
// main() は走らない(実測済み。ブリーフ Step 1「listen せず app.request で検証」の要求どおり)。
if (import.meta.main) {
  main();
}
