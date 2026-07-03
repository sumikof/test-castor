// tests/unit/http-app.test.ts
// createApp(deps): deps注入ミドルウェア → (以後のタスクが /api/v1 ルートを追記) → onError/notFound の
// 組み立てを検証する。ROLE_RANK の値も確認する。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp, ROLE_RANK, type AppDeps } from '../../src/http/app';
import { AppError } from '../../src/http/errors';

function makeDeps(): AppDeps {
  return {
    storage: {} as AppDeps['storage'],
    auth: {} as AppDeps['auth'],
    config: {} as AppDeps['config'],
    loginLimiter: { limit: async () => ({ allowed: true }) },
    syncLimiter: { limit: async () => ({ allowed: true }) },
    now: () => 1_700_000_000_000,
  };
}

describe('http/app: ROLE_RANK', () => {
  it('viewer < editor < admin の順にランクが増える', () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.editor);
    expect(ROLE_RANK.editor).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK).toEqual({ viewer: 1, editor: 2, admin: 3 });
  });
});

describe('http/app: createApp', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('deps 注入ミドルウェアが c.set(\'deps\', deps) する(後続ルートが c.get(\'deps\') で読める)', async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    app.get('/probe', (c) => c.json({ sameInstance: c.get('deps') === deps }));
    const res = await app.request('/probe');
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toEqual({ sameInstance: true });
  });

  it('未定義ルート(存在しないパス) → 404 統一エラースキーマ NOT_FOUND', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json<any>()).toEqual({ error: { code: 'NOT_FOUND', message: 'not found', retryable: false } });
  });

  it('ルートが AppError を投げる → onError 経由で統一スキーマ + 該当 status', async () => {
    const app = createApp(makeDeps());
    app.get('/boom', () => { throw new AppError('FORBIDDEN', 403, 'insufficient role'); });
    const res = await app.request('/boom');
    expect(res.status).toBe(403);
    expect(await res.json<any>()).toEqual({ error: { code: 'FORBIDDEN', message: 'insufficient role', retryable: false } });
  });

  it('ルートが予期しない例外を投げる → 500 INTERNAL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp(makeDeps());
    app.get('/boom', () => { throw new Error('unexpected'); });
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json<any>()).toEqual({ error: { code: 'INTERNAL', message: 'internal error', retryable: true } });
  });

  it('ルートが non-Error 値(文字列)を throw しても GC-4 の統一スキーマで 500 INTERNAL になる', async () => {
    // Hono の compose() は `err instanceof Error` の場合のみ onError へルーティングする
    // (hono/dist/compose.js で確認済み)。deps 注入ミドルウェアがチェーン最外周で正規化するため、
    // アプリのどこかで誤って非 Error 値を throw しても統一スキーマから逸脱しないことを保証する。
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp(makeDeps());
    app.get('/boom-string', () => { throw 'plain string throw'; });
    const res = await app.request('/boom-string');
    expect(res.status).toBe(500);
    expect(await res.json<any>()).toEqual({ error: { code: 'INTERNAL', message: 'internal error', retryable: true } });
  });

  it('POST 未定義ルートも 404 統一エラースキーマになる(メソッド問わず)', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/nope', { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
  });
});
