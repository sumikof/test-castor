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

  // C10(HANDOVER §4.2)以降、depsFrom は署名鍵 config(loadConfig/loadSigningKeys)を読まない。
  // 以前ここにあった「不正な SESSION_SIGNING_KEYS → bootstrap 失敗ログ + スキップ」テストは前提が
  // 消えたため、同じポイズン値で「cron は鍵設定と無関係に maintenance を完走する」ことを検証する
  // (fetch 側の bootstrap 失敗が GC-4 スキーマで返ることは上のテストが引き続き担保する)。
  it('scheduled: SESSION_SIGNING_KEYS が不正でも maintenance は実行される(C10: cron は署名鍵を読まない)', async () => {
    const setupRes = await SELF.fetch('https://example.com/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organization_name: 'Acme3', admin_email: 'admin3@example.com',
        admin_password: 'admin-pass-1', admin_display_name: 'Admin3',
      }),
    });
    expect(setupRes.status).toBe(201);
    const setupBody = await setupRes.json<any>();
    const userId = setupBody.user.id as string;

    const expiredAt = Date.now() - 1000;
    await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind('sess-badkeys-expired', userId, expiredAt, expiredAt - 100_000)
      .run();

    const poisonedEnv = { ...env, SESSION_SIGNING_KEYS: 'not-valid-json' };
    const ctx = createExecutionContext();
    const controller = createScheduledController();
    expect(() => workersEntry.scheduled(controller, poisonedEnv as any, ctx)).not.toThrow();
    await waitOnExecutionContext(ctx);

    // 鍵が不正でも maintenance は走り、期限切れセッションが削除されている(識別: 実効果で確認)
    const remaining = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?').bind('sess-badkeys-expired').first();
    expect(remaining).toBeNull();
  });

  // レビュー finding(re-review round2)「catch scope swallows genuine maintenance failures」:
  // runScheduledMaintenance の try は現状 await runMaintenance(depsFrom(env)) 全体を包んでいるため、
  // bootstrap(depsFrom)成功後に発生する genuine な実行時失敗(D1エラー等。maintenance の各ステップ
  // 自体は内部でtry/catchしない)まで bootstrap 失敗と同じ catch に飲み込まれ、
  // scheduled_maintenance_bootstrap_failed という誤ったイベント名でログされたうえ、ctx.waitUntil に
  // 渡した Promise が reject せず解決してしまう(= プラットフォームのエラー監視/cron再試行へ伝わる
  // はずの reject シグナルを握りつぶす)。修正後は depsFrom(env) だけを狭い try/catch で囲み、
  // runMaintenance(deps) 自体はその外側で(ガードなしで)呼ぶ。
  //
  // poisonedD1 は D1Database のうち adapter(src/storage/adapters/d1.ts→drizzle-orm)が最初に
  // 触るメソッド(prepare/batch/exec)を全て意図的に投げるようにしたスタブ。drizzle(d1) の構築自体
  // (createD1Storage→depsFrom)はクエリを一切発行しない(node_modules/drizzle-orm/d1/driver.js
  // 参照。client を保持するだけ)ため bootstrap は成功し、runMaintenance 内の最初のクエリ
  // (purgeObservationsUntilDone→storage.purgeObservations→driver.batch→db.batch→session.batch→
  // client.prepare)で初めて失敗する。
  //
  // 実装注記: このテストは意図的に createExecutionContext()/waitOnExecutionContext() を使わない。
  // 実際に試したところ(このプールのこのバージョン。dist/worker/lib/cloudflare/test-runner.mjsの
  // updateStackedStorage/waitForGlobalWaitUntil、test-internal.mjsのregisterGlobalWaitUntil)、
  // 実 ExecutionContext.waitUntil() はローカルの追跡配列に加えてプール内部のモジュールグローバルな
  // 追跡配列にも同じ Promise を登録し、isolatedStorage の push/pop 境界(onBeforeTryTask/
  // onAfterTryTask)毎にそのグローバル配列を drain して reject を re-throw する。
  // waitOnExecutionContext(ctx) はローカル配列しか drain しないため、reject する Promise をそこで
  // 使うと「アサーション自体は通ったのに直後の after-hook 境界で同じ reject が再度観測されテストが
  // 二重に失敗する」(プール固有の挙動。素の createExecutionContext() + reject する waitUntil +
  // waitOnExecutionContext での局所catchだけを使った使い捨て実験で実際に再現・確認した)。
  // ctx.waitUntil(p) を呼ぶだけの最小限のフェイクオブジェクトに差し替えることでこのプール固有の
  // グローバル二重登録を回避しつつ、「scheduled が ctx.waitUntil に渡す Promise が reject する」
  // という finding の本質は実 workersEntry.scheduled 経由でそのまま検証する。
  it('scheduled: bootstrap成功後の実行時エラー(D1障害)はbootstrap失敗として握りつぶさずwaitUntilへ伝播する', async () => {
    const poisonedD1 = {
      prepare(): never { throw new Error('simulated d1 outage'); },
      batch(): never { throw new Error('simulated d1 outage'); },
      exec(): never { throw new Error('simulated d1 outage'); },
    } as unknown as D1Database;
    const poisonedEnv = { ...env, DB: poisonedD1 };
    const controller = createScheduledController();
    let captured: Promise<unknown> | undefined;
    const fakeCtx = { waitUntil(p: Promise<unknown>) { captured = p; } } as unknown as ExecutionContext;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      workersEntry.scheduled(controller, poisonedEnv as any, fakeCtx);
      expect(captured).toBeDefined();
      await expect(captured!).rejects.toThrow('simulated d1 outage');

      // bootstrap(depsFrom)自体は成功しているはずなので、bootstrap失敗の構造化ログ(誤ラベル)は
      // 出ない(=実行時失敗をbootstrap失敗として握りつぶす旧挙動に戻っていないことの確認)。
      const parsedCalls = errorSpy.mock.calls
        .map((args) => { try { return JSON.parse(String(args[0])); } catch { return undefined; } });
      expect(parsedCalls.some((p) => p?.event === 'scheduled_maintenance_bootstrap_failed')).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
