// src/entry/workers.ts
// task-22-brief.md「Workers エントリ本実装(scheduled)」。Task 1 の仮実装(501固定)を置換する。
//
// GC-6 の唯一の例外ファイル(designated CF-specific file。architecture.md「依存方向」): ここだけが
// @cloudflare/workers-types のアンビエント型(D1Database/Fetcher/ExecutionContext/ScheduledController/
// ExportedHandler)を直接参照してよい。tsconfig.json の "types" でグローバル解決されるため個別の
// import 文は不要(src/storage/adapters/d1.ts が D1Database を無 import で使うのと同じ流儀)。
//
// fetch: env から AppDeps を組み立てて createApp(deps) する(getApp)。isolate内(同一Workerの
// 生存期間中に複数回呼ばれる fetch/scheduled 呼び出し間)でアプリ・Storage・Auth・RateLimiter を
// 使い回すため、env をキーにした WeakMap でキャッシュする(ブリーフ「isolate内キャッシュ」)。
// scheduled: wrangler.jsonc の triggers.crons(Task 1 で設定済み。spec「Cron Triggers(1時間毎)」＝
// "0 * * * *")から呼ばれ、runMaintenance を ctx.waitUntil で実行する(ブリーフの shape のまま)。
import { Hono } from 'hono';
import { createApp, type AppDeps, type AppEnv } from '../http/app';
import { loadConfig } from '../http/config';
import { toErrorResponsePayload } from '../http/errors';
import { createD1Storage } from '../storage/adapters/d1';
import { createWebcryptoAuth } from '../auth/webcrypto-auth';
import { createMemoryRateLimiter } from '../ratelimit/memory';
import { runMaintenance, type MaintenanceDeps } from '../maintenance';

/**
 * wrangler.jsonc のバインディング一式(d1_databases.DB・assets.ASSETS)+ src/http/config.ts の
 * loadConfig が読む環境変数(すべて文字列・省略可。未設定時のフォールバック/既定値は config.ts 参照。
 * SESSION_TTL_MS は wrangler.jsonc の vars に設定済み、SESSION_SIGNING_KEYS は
 * `wrangler secret put` で投入する運用 — wrangler.jsonc のコメント参照)。
 */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_TTL_MS?: string;
  SESSION_SIGNING_KEYS?: string;
  SESSION_ACTIVE_KEY_ID?: string;
  PBKDF2_ITERATIONS?: string;
  LOGIN_RATE_LIMIT_WINDOW_MS?: string;
  LOGIN_RATE_LIMIT_MAX?: string;
  SYNC_RATE_LIMIT_WINDOW_MS?: string;
  SYNC_RATE_LIMIT_MAX?: string;
  OBSERVATION_RETENTION_MS?: string;
  IDENTITY_TTL_MS?: string;
  SYNC_COMMIT_WINDOW_LIMIT?: string;
}

/** fetch/scheduled 共通の AppDeps 組み立て(D1 storage・WebCrypto Auth・メモリ RateLimiter・実クロック)。 */
function buildDeps(env: Env): AppDeps {
  // env は D1Database/Fetcher(非文字列のバインディング)を含む構造体だが、loadConfig が実際に読むのは
  // 文字列環境変数のみで、余分なキー(DB/ASSETS)が渡っても動作に影響しない(config.ts 参照)。
  const config = loadConfig(env as unknown as Record<string, string | undefined>);
  const { storage } = createD1Storage(env.DB);
  const auth = createWebcryptoAuth({
    signingKeys: config.signingKeys, activeKeyId: config.activeKeyId, pbkdf2Iterations: config.pbkdf2Iterations,
  });
  const now = () => Date.now(); // GC-3: 実クロックを読むのは entry 層のみ
  return {
    storage, auth, config, now,
    loginLimiter: createMemoryRateLimiter(config.loginRateLimit, now),
    syncLimiter: createMemoryRateLimiter(config.syncRateLimit, now),
  };
}

// isolate内キャッシュ(ブリーフ明記)。CF の実行モデルでは env は isolate の生存期間中ずっと同一
// オブジェクト参照であるため、WeakMap をキーにすることで「同一 env なら使い回し・env が変われば
// (テスト等で複数 env が現れても)独立に構築し直す」の両方を安全に扱える。
const appCache = new WeakMap<Env, Hono<AppEnv>>();

function getApp(env: Env): Hono<AppEnv> {
  const cached = appCache.get(env);
  if (cached) return cached;
  const app = createApp(buildDeps(env));
  appCache.set(env, app);
  return app;
}

/** scheduled ハンドラ用の MaintenanceDeps(retentionMs は config.observationRetentionMs をそのまま使う)。 */
function depsFrom(env: Env): MaintenanceDeps {
  const deps = buildDeps(env);
  return { storage: deps.storage, now: deps.now, retentionMs: deps.config.observationRetentionMs };
}

/**
 * scheduled 本体。depsFrom(env)(config 読み込み含む)を try/catch で包み、config bootstrap 失敗
 * (不正な SESSION_SIGNING_KEYS 等、src/http/config.ts が同期的に throw する分岐)が ctx.waitUntil の
 * 外へ素の同期例外として漏れないようにする(レビュー finding #1)。GC-4 自体は fetch のエラー応答
 * スキーマの話で scheduled には直接適用されないが、「ハンドラから未捕捉例外を漏らさない」という
 * 同じ趣旨で保護する。失敗時は runMaintenance と同じ {"event":...} 構造化ログ流儀で1行出し、
 * この回のメンテナンスはスキップする(同じ設定不備はどのみち全 HTTP トラフィックを壊すため、
 * cron 側は二次的な保険で十分 — buildDeps/getApp/depsFrom 自体の構造は変えない最小限の変更)。
 */
async function runScheduledMaintenance(env: Env): Promise<void> {
  try {
    await runMaintenance(depsFrom(env));
  } catch (err) {
    console.error(JSON.stringify({
      event: 'scheduled_maintenance_bootstrap_failed',
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    try {
      return getApp(env).fetch(req, env, ctx);
    } catch (err) {
      // GC-4: Hono の onError(errorMiddleware)は app.fetch() 呼び出しが始まった後にしか効かない。
      // getApp(env)→buildDeps(env)(config 読み込み含む)がここに来る前に同期的に throw すると、
      // errorMiddleware を経由せず生の例外が isolate の外へ漏れ、統一エラースキーマ以外を返さない
      // という GC-4 の保証を破る(レビュー finding #1)。errorMiddleware と同じ変換ロジック
      // (toErrorResponsePayload, src/http/errors.ts)を再利用することで、鍵材料等の設定詳細を
      // message に含めない・スキーマを二重実装しない、の両方を保証する。
      const { status, body } = toErrorResponsePayload(err);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
