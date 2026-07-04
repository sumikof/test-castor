// tests/integration/entry.test.ts
// task-22-brief.md Step 3「workers pool の SELF/app 経由で GET / 302 と /api/v1/setup が動く
// (エントリ配線の確認)」。他の統合テストと異なり、直接 createApp() を呼ぶのではなく、
// wrangler.jsonc の main が指す src/entry/workers.ts の実際の default export を、
// @cloudflare/vitest-pool-workers の SELF(fetchのService binding)経由で検証する
// (getApp(env) による AppDeps 組み立て・isolate内キャッシュを含めた実配線の確認)。
// scheduled ハンドラは SELF では呼べない(Fetcher は fetch のみ)ため、モジュールを直接 import して
// createExecutionContext/createScheduledController/waitOnExecutionContext(cloudflare:test 標準ヘルパ)
// で駆動する。
import { describe, it, expect, beforeEach } from 'vitest';
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
});
