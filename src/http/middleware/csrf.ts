// src/http/middleware/csrf.ts
// D-09: HttpOnly Cookie + サーバー埋込型 double-submit CSRF 防御。
// 一次防御(SameSite=Lax)を Cookie 属性側で持たせつつ、ここでは二次防御(状態変更メソッドでの
// Cookie値/送信値一致検証)のみを担当する。Bearer トークン認証(衛星)は Cookie を使わないため
// 検証対象外(auth-security.md「CSRF 防御」)。
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { AppError } from '../errors';

export const SESSION_COOKIE = 'session';
export const CSRF_COOKIE = 'csrf';

/** 全 Cookie 発行箇所(login/setup 等)が共有する属性(auth-security.md「Cookie 属性(必須)」)。 */
export const COOKIE_ATTRS = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' } as const;

/** `session=<value>; HttpOnly; Secure; SameSite=Lax; Path=/` を返す(Set-Cookie 値の手組み立て用)。 */
export function sessionCookieHeader(value: string): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);

export function csrfProtect(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor');
    if (actor?.kind === 'user' && STATE_CHANGING_METHODS.has(c.req.method)) {
      const cookie = getCookie(c, CSRF_COOKIE);
      let submitted = c.req.header('x-csrf-token');
      if (!submitted) {
        const ct = c.req.header('content-type') ?? '';
        if (ct.includes('form')) {
          const body = await c.req.parseBody();
          const field = body['_csrf'];
          submitted = typeof field === 'string' ? field : undefined;
        }
      }
      // double-submit トークンは秘密鍵ではないため定数時間比較は不要(D-09)。署名/パスワードの定数時間比較とは意図的に異なる。
      if (!cookie || !submitted || cookie !== submitted) {
        throw new AppError('FORBIDDEN', 403, 'csrf token mismatch');
      }
    }
    await next();
  };
}
