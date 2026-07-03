// tests/unit/middleware-error.test.ts
// 統一エラースキーマ(GC-4, api-reference.md「統一エラースキーマ」)を検証する:
// AppError → {error:{code,message,details,retryable}} + 該当status / ZodError(zValidator hook 経由)
// → 422 VALIDATION_FAILED + details:[{path,msg}] / 予期しない例外 → 500 INTERNAL(固定メッセージ、詳細はログのみ)。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { AppError } from '../../src/http/errors';
import { errorMiddleware, zodHook } from '../../src/http/middleware/error';

describe('AppError', () => {
  it('code/status/message/details/retryable を保持し、Error のサブクラスである', () => {
    const err = new AppError('NOT_FOUND', 404, 'not found', { hint: 'x' }, true);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe('AppError');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.message).toBe('not found');
    expect(err.details).toEqual({ hint: 'x' });
    expect(err.retryable).toBe(true);
  });

  it('retryable 省略時は false になる', () => {
    const err = new AppError('UNAUTHORIZED', 401, 'authentication required');
    expect(err.retryable).toBe(false);
  });

  it('details 省略時は undefined', () => {
    const err = new AppError('FORBIDDEN', 403, 'insufficient role');
    expect(err.details).toBeUndefined();
  });
});

describe('errorMiddleware: AppError → 統一スキーマ + 該当 status', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function appWithRoute(handler: () => never) {
    const app = new Hono();
    app.onError(errorMiddleware);
    app.get('/x', () => handler());
    return app;
  }

  it('AppError(details あり) → status/JSON body が一致', async () => {
    const app = appWithRoute(() => { throw new AppError('VALIDATION_FAILED', 422, 'bad input', [{ path: 'title', msg: 'Required' }], false); });
    const res = await app.request('/x');
    expect(res.status).toBe(422);
    expect(await res.json<any>()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'bad input', details: [{ path: 'title', msg: 'Required' }], retryable: false },
    });
  });

  it('AppError(details なし) → details キーは JSON に含まれない', async () => {
    const app = appWithRoute(() => { throw new AppError('NOT_FOUND', 404, 'not found'); });
    const res = await app.request('/x');
    expect(res.status).toBe(404);
    const body = await res.json<any>();
    expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'not found', retryable: false } });
    expect('details' in body.error).toBe(false);
  });

  it('AppError(retryable:true, 例: RATE_LIMITED) → retryable がそのまま伝播', async () => {
    const app = appWithRoute(() => { throw new AppError('RATE_LIMITED', 429, 'too many attempts', undefined, true); });
    const res = await app.request('/x');
    expect(res.status).toBe(429);
    expect(await res.json<any>()).toEqual({ error: { code: 'RATE_LIMITED', message: 'too many attempts', retryable: true } });
  });

  it('予期しない例外(プレーン Error) → 500 INTERNAL、メッセージは固定文言("internal error")で実メッセージを漏らさない', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appWithRoute(() => { throw new Error('leaked-db-password=hunter2'); });
    const res = await app.request('/x');
    expect(res.status).toBe(500);
    const body = await res.json<any>();
    expect(body).toEqual({ error: { code: 'INTERNAL', message: 'internal error', retryable: true } });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    // ログには実エラーが残る(D-11 の精神: 監査/デバッグ用に詳細はサーバ側ログにのみ出す)
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toContain('leaked-db-password=hunter2');
  });

  it('errorMiddleware 自体は non-Error 値(文字列 throw 等)を渡されてもクラッシュせず 500 INTERNAL を返す', async () => {
    // 注意: Hono の compose() は `err instanceof Error` の場合のみ onError へルーティングする
    // (non-Error 値は onError を経由せずそのまま再 throw される。hono/dist/compose.js で確認済み)。
    // そのため「アプリのルートで文字列を throw した場合に onError 経由で 500 になる」という経路は
    // Hono の設計上そもそも存在しない(このコードベースは常に AppError または本物の Error を投げる)。
    // ここでは errorMiddleware という「関数自体」の防御(String(err)・(err as Error)?.stack が
    // non-Error でも例外を投げないこと)を、onError 経由ではなく直接呼び出して確認する。
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = new Hono();
    app.get('/x', (c) => errorMiddleware('plain string throw', c));
    const res = await app.request('/x');
    expect(res.status).toBe(500);
    expect(await res.json<any>()).toEqual({ error: { code: 'INTERNAL', message: 'internal error', retryable: true } });
  });
});

describe('zodHook: ZodError(zValidator hook 経由) → 422 VALIDATION_FAILED + details:[{path,msg}]', () => {
  const schema = z.object({ title: z.string().min(1), age: z.number().int().min(0) });

  function appWithValidatedRoute() {
    const app = new Hono();
    app.onError(errorMiddleware);
    app.post('/x', zValidator('json', schema, zodHook), (c) => c.json({ ok: true, data: c.req.valid('json') }));
    return app;
  }

  it('不正な入力 → 422 VALIDATION_FAILED、details に path/msg が入る', async () => {
    const app = appWithValidatedRoute();
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '', age: -1 }),
    });
    expect(res.status).toBe(422);
    const body = await res.json<any>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toBe('validation failed');
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
    for (const d of body.error.details) {
      expect(typeof d.path).toBe('string');
      expect(typeof d.msg).toBe('string');
    }
    expect(body.error.details.some((d: { path: string }) => d.path === 'title')).toBe(true);
    expect(body.error.details.some((d: { path: string }) => d.path === 'age')).toBe(true);
  });

  it('妥当な入力 → ハンドラまで到達し 200', async () => {
    const app = appWithValidatedRoute();
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ok', age: 3 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toEqual({ ok: true, data: { title: 'ok', age: 3 } });
  });

  it('ネストしたフィールドの path はドット区切りになる', async () => {
    const nested = z.object({ user: z.object({ email: z.string().email() }) });
    const app = new Hono();
    app.onError(errorMiddleware);
    app.post('/y', zValidator('json', nested, zodHook), (c) => c.json({ ok: true }));
    const res = await app.request('/y', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: { email: 'not-an-email' } }),
    });
    expect(res.status).toBe(422);
    const body = await res.json<any>();
    expect(body.error.details).toEqual([{ path: 'user.email', msg: expect.any(String) }]);
  });
});
