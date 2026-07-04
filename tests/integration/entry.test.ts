// tests/integration/entry.test.ts
// task-22-brief.md Step 3「workers pool の SELF/app 経由で GET / 302 と /api/v1/setup が動く
// (エントリ配線の確認)」。他の統合テストと異なり、直接 createApp() を呼ぶのではなく、
// wrangler.jsonc の main が指す src/entry/workers.ts の実際の default export を、
// @cloudflare/vitest-pool-workers の SELF(fetchのService binding)経由で検証する
// (getApp(env) による AppDeps 組み立て・isolate内キャッシュを含めた実配線の確認)。
// scheduled ハンドラは SELF では呼べない(Fetcher は fetch のみ)ため、モジュールを直接 import して
// createExecutionContext/createScheduledController/waitOnExecutionContext(cloudflare:test 標準ヘルパ)
// で駆動する。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, SELF, createExecutionContext, waitOnExecutionContext, createScheduledController } from 'cloudflare:test';
import workersEntry from '../../src/entry/workers';

const WIPE_ORDER = [
  'test_case_history', 'test_case_observations', 'sync_seen', 'sync_staging', 'sync_sessions',
  'test_case_identities', 'test_cases', 'api_tokens', 'sessions', 'projects', 'users', 'organizations',
];

describe('統合: entry(src/entry/workers.ts の実配線)', () => {
  beforeEach(async () => {
    for (const t of WIPE_ORDER) await env.DB.exec(`DELETE FROM ${t}`);
  });

  it('GET / は組織0件のとき302で/setupへ(fetch: getApp(env)→createApp配線の確認)', async () => {
    // SELF.fetch は通常の fetch と同じく既定でリダイレクトを追従する(Hono の app.request と異なる)ため、
    // 302 そのものを観測するには redirect:'manual' を明示する。
    const res = await SELF.fetch('https://example.com/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/setup');
  });

  it('POST /api/v1/setup が実D1に対して201で成功する(fetch: 実storage配線の確認。2回目呼び出しでもisolateキャッシュ経由で正しく動く)', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organization_name: 'Acme', admin_email: 'admin@example.com',
        admin_password: 'admin-pass-1', admin_display_name: 'Admin',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<any>();
    expect(body.organization.name).toBe('Acme');

    // 2回目のfetch(同一isolateでキャッシュされたgetApp経由)でもDBの状態を正しく反映する
    // (D-13-1: 既にorgが存在するので / は /login へ)
    const res2 = await SELF.fetch('https://example.com/', { redirect: 'manual' });
    expect(res2.status).toBe(302);
    expect(res2.headers.get('location')).toBe('/login');
  });

  it('scheduled は depsFrom(env) を組み立てて runMaintenance を実行する(エントリ配線の確認)', async () => {
    const setupRes = await SELF.fetch('https://example.com/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organization_name: 'Acme2', admin_email: 'admin2@example.com',
        admin_password: 'admin-pass-1', admin_display_name: 'Admin2',
      }),
    });
    expect(setupRes.status).toBe(201);
    const setupBody = await setupRes.json<any>();
    const userId = setupBody.user.id as string;

    // 期限切れUIセッションを直接D1へ仕込む(runMaintenance→deleteExpiredUiSessionsで消えるはず)
    const expiredAt = Date.now() - 1000;
    await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind('sess-entry-expired', userId, expiredAt, expiredAt - 100_000)
      .run();

    const ctx = createExecutionContext();
    const controller = createScheduledController();
    workersEntry.scheduled(controller, env as any, ctx);
    await waitOnExecutionContext(ctx); // ctx.waitUntil(runMaintenance(...)) の完了を待つ

    const remaining = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?').bind('sess-entry-expired').first();
    expect(remaining).toBeNull();
  });

  // レビュー finding #1(GC-4 bypass on config-bootstrap failure): getApp(env)→buildDeps(env)→
  // loadConfig/loadSigningKeys は Hono の app.fetch() より前に同期的に throw しうる(不正な
  // SESSION_SIGNING_KEYS 等)。これは errorMiddleware(app.onError)より前で起きるため、直さないと
  // 生の例外が isolate の外へ漏れ、GC-4(統一エラースキーマ以外を返さない)を破る。
  // ポイズン値には「malformed JSON」を使う: absent/undefined は warn+dev フォールバックの
  // 非throw分岐に落ちるため、ポイズンとして不適(brief注記のとおり)。
  it('fetch: config bootstrap失敗(不正なSESSION_SIGNING_KEYS)時もGC-4統一エラースキーマ(500 INTERNAL/retryable)を返し、鍵材料を漏らさない', async () => {
    const poisonedEnv = { ...env, SESSION_SIGNING_KEYS: 'not-valid-json' };
    const ctx = createExecutionContext();
    const res = await workersEntry.fetch(new Request('https://example.com/'), poisonedEnv as any, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(500);
    const body = await res.json<any>();
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.retryable).toBe(true);
    expect(JSON.stringify(body)).not.toContain('not-valid-json');
  });

  it('scheduled: config bootstrap失敗時も例外を漏らさずに完了する(構造化ログを出し、この回のメンテナンスはスキップ)', async () => {
    const poisonedEnv = { ...env, SESSION_SIGNING_KEYS: 'not-valid-json' };
    const ctx = createExecutionContext();
    const controller = createScheduledController();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => workersEntry.scheduled(controller, poisonedEnv as any, ctx)).not.toThrow();
      await waitOnExecutionContext(ctx);

      // 構造化 {"event":...} ログ(runMaintenance と同じ流儀)が出ることを確認する。
      // サーバ側ログは D-11 の精神どおり詳細(err.message)を含めてよい — 漏らしてはいけないのは
      // fetch のレスポンス本文(上のテストで検証済み)であって、サーバ内部ログではない。
      expect(errorSpy).toHaveBeenCalled();
      const parsedCalls = errorSpy.mock.calls
        .map((args) => { try { return JSON.parse(String(args[0])); } catch { return undefined; } });
      expect(parsedCalls.some((p) => p?.event === 'scheduled_maintenance_bootstrap_failed')).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
