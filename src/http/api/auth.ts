// src/http/api/auth.ts
// 認証 API(docs/apis/auth.md): login/logout/me/password。
// - login: 認証不要。(email, ip) キーの loginLimiter で D-14(5失敗/15分)のブルートフォース防御を行う。
//   事前チェックは consume:false(正しいパスワードの試行はカウントに含めない)、失敗時のみ consume する
//   非対称消費が肝。成功時はセッション固定攻撃対策として必ず新規セッションIDを発行する
//   (auth-security.md「不変条件」)。
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

export const authRoutes = new Hono<AppEnv>()
  .post('/login', zValidator('json', loginInput, zodHook), async (c) => {
    const deps = c.get('deps');
    const { email, password } = c.req.valid('json');
    const ip = c.req.header('cf-connecting-ip') ?? 'local';
    const key = `login:${email}:${ip}`;

    // 事前チェック(consume:false): 既にブロック中なら検証すら行わず429(D-14)。
    const gate = await deps.loginLimiter.limit(key, { consume: false });
    if (!gate.allowed) {
      c.header('Retry-After', String(gate.retryAfterSec ?? 60));
      throw new AppError('RATE_LIMITED', 429, 'too many attempts', undefined, true);
    }

    const user = await deps.storage.findUserForLogin(email);
    // 未知 email(user=null)・パスワード未設定(passwordHash=null)でも、既知 email+誤りパスワードと
    // 同じコストの PBKDF2 を必ず1回実行させる(verifyPassword に null をそのまま渡す)。ここで
    // 「該当なしなら検証すらしない」早期分岐を作ると、応答時間差から email の存在有無が漏れる
    // (タイミングサイドチャネルによるユーザー列挙。auth-security.md「タイミング攻撃対策」)。
    const result = await deps.auth.verifyPassword(password, user?.passwordHash ?? null);

    if (!user || !result.ok) {
      // 失敗した試行のみ consume する(正しいパスワードの試行はカウントしない非対称レート制限)。
      await deps.loginLimiter.limit(key);
      // D-11: 認証失敗監査は構造化 JSON ログのみ(D1 監査テーブルは持たない)。
      console.warn(JSON.stringify({ event: 'auth_failure', email, ip, at: deps.now() }));
      // 未知 email / 誤パスワードを区別しない統一メッセージ(存在有無を漏らさない)。
      throw new AppError('UNAUTHORIZED', 401, 'invalid email or password');
    }

    const scope = { organizationId: user.organizationId };
    if (result.needsRehash) {
      // 透過再ハッシュ: 旧イテレーション数の PHC を検出したら現行設定で再ハッシュして保存する
      // (auth-security.md「透過再ハッシュ」)。
      await deps.storage.setUserPassword(scope, user.id, await deps.auth.hashPassword(password), deps.now());
    }
    await deps.storage.touchLastLogin(scope, user.id, deps.now()); // D-05: last_login_at 更新

    // セッション固定攻撃対策: ログイン成功時は必ず新規セッションIDを発行する(auth-security.md「不変条件」)。
    const sid = deps.auth.newSessionId();
    await deps.storage.createSession({
      id: sid,
      userId: user.id,
      expiresAt: deps.now() + deps.config.sessionTtlMs,
      createdAt: deps.now(),
    });
    setCookie(c, SESSION_COOKIE, await deps.auth.signSessionId(sid), COOKIE_ATTRS);
    setCookie(c, CSRF_COOKIE, deps.auth.newCsrfToken(), COOKIE_ATTRS);

    // apis/auth.md の login レスポンスは user.{id,email,display_name,role} のみ(created_at 等は
    // 含まない)。toUserJson は以後のタスク向けの完全形なので、ここでは契約に合わせて絞り込む。
    const { created_at: _createdAt, updated_at: _updatedAt, last_login_at: _lastLoginAt, ...loginUser } = toUserJson(user);
    return c.json({ user: loginUser });
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
