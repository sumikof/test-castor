// src/http/api/auth.ts
// 認証 API(docs/apis/auth.md): login/logout/me/password。
// - login: 認証不要。(email, ip) キーの loginLimiter で D-14(5失敗/15分)のブルートフォース防御を行う。
//   事前チェックは consume:false(正しいパスワードの試行はカウントに含めない)、失敗時のみ consume する
//   非対称消費が肝。成功時はセッション固定攻撃対策として必ず新規セッションIDを発行する
//   (auth-security.md「不変条件」)。ログイン本体のロジックは task-17 で
//   src/domain/services/auth-service.ts の loginUser() へ抽出済み。UI ルート(src/http/ui/auth-pages.tsx)
//   も同じ関数を呼ぶ(内部 HTTP 往復はしない=承認済みアプローチ A)。ここでは
//   JSON レスポンス組み立て・Cookie 発行・エラーコードへのマッピングのみを担う。
// - logout/me/password: セッション必須。logout/password は状態変更のため CSRF 必須(D-09)。
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { AppError } from '../errors';
import { zodHook } from '../middleware/error';
import { requireAuth } from '../middleware/authn';
import { csrfProtect, SESSION_COOKIE, CSRF_COOKIE, COOKIE_ATTRS } from '../middleware/csrf';
import { orgScopeOf } from '../middleware/scope';
import { loginInput, changePasswordInput } from '../../schemas/api';
import { toUserJson } from './serializers';
import { loginUser } from '../../domain/services/auth-service';

export const authRoutes = new Hono<AppEnv>()
  .post('/login', zValidator('json', loginInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const { email, password } = c.req.valid('json');
    const ip = c.req.header('cf-connecting-ip') ?? 'local';

    const result = await loginUser(deps, { email, password, ip });
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        c.header('Retry-After', String(result.retryAfterSec));
        throw new AppError('RATE_LIMITED', 429, 'too many attempts', undefined, true);
      }
      // 未知 email / 誤パスワードを区別しない統一メッセージ(存在有無を漏らさない)。
      throw new AppError('UNAUTHORIZED', 401, 'invalid email or password');
    }

    setCookie(c, SESSION_COOKIE, await deps.auth.signSessionId(result.sessionId), COOKIE_ATTRS);
    setCookie(c, CSRF_COOKIE, deps.auth.newCsrfToken(), COOKIE_ATTRS);

    // apis/auth.md の login レスポンスは user.{id,email,display_name,role} のみ(created_at 等は
    // 含まない)。toUserJson は以後のタスク向けの完全形なので、ここでは契約に合わせて絞り込む。
    const { created_at: _createdAt, updated_at: _updatedAt, last_login_at: _lastLoginAt, ...loginUserJson } = toUserJson(result.user);
    return c.json({ user: loginUserJson });
  })

  .post('/logout', requireAuth({ modes: ['session'] }), csrfProtect(), async (c) => {
    const deps = c.get('deps');
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    await deps.storage.deleteSession(actor.sessionId);
    deleteCookie(c, SESSION_COOKIE, COOKIE_ATTRS);
    deleteCookie(c, CSRF_COOKIE, COOKIE_ATTRS);
    return c.body(null, 204);
  })

  .get('/me', requireAuth({ modes: ['session'] }), async (c) => {
    const actor = c.get('actor');
    if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    const { user } = actor;
    return c.json({
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      role: user.role,
      organization_id: user.organizationId,
    });
  })

  .patch(
    '/password',
    requireAuth({ modes: ['session'] }),
    csrfProtect(),
    zValidator('json', changePasswordInput, zodHook),
    async (c) => {
      const deps = c.get('deps');
      const actor = c.get('actor');
      if (actor.kind !== 'user') throw new AppError('UNAUTHORIZED', 401, 'authentication required');
      const { current_password, new_password } = c.req.valid('json');
      const { user, sessionId } = actor;

      const result = user.passwordHash
        ? await deps.auth.verifyPassword(current_password, user.passwordHash)
        : { ok: false, needsRehash: false };
      if (!result.ok) throw new AppError('UNAUTHORIZED', 401, 'invalid current password');

      const scope = orgScopeOf(actor);
      await deps.storage.setUserPassword(scope, user.id, await deps.auth.hashPassword(new_password), deps.now());
      // 当該ユーザーの他の全セッションを無効化する。自セッションは維持する(apis/auth.md「副作用・業務ルール」)。
      await deps.storage.deleteUserSessions(user.id, sessionId);

      return c.json({ message: 'password_changed' });
    },
  );
