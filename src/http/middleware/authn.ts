// src/http/middleware/authn.ts
// 到達面分離(能力マトリクス)+ RBAC の共通執行点(auth-security.md「認証・認可ミドルウェア執行仕様」)。
// セッションは三段AND(署名検証 → DB 存在確認 → expires_at > now)を必ず通す。失効セッションは検出時に
// 行削除する。トークンは「失効チェックを認証述語に内包」(WHERE token_hash=? AND revoked_at IS NULL)を
// Storage.findApiTokenByHash が担う。
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { ROLE_RANK } from '../app';
import { AppError } from '../errors';
import { SESSION_COOKIE } from './csrf';
import type { Role } from '../../schemas/enums';

/** best-effort な last_used_at 間引き更新の閾値(auth-security.md「last_used_at 更新」の「例: 1分」)。 */
const TOKEN_LAST_USED_THRESHOLD_MS = 60_000;

export function requireAuth(opts: { modes: Array<'session' | 'token'>; minRole?: Role }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];

    if (bearer) {
      const hash = await deps.auth.hashApiToken(bearer);
      const token = await deps.storage.findApiTokenByHash(hash); // 失効は述語内包(revoked_at IS NULL)
      if (!token) throw new AppError('UNAUTHORIZED', 401, 'invalid token');
      // 認証(トークンの真正性)は通った。だがこのルートが token を許可しないなら「認証済みだが禁止」= 403
      // (能力マトリクス: 禁止 → 403。401 ではない点が UNAUTHORIZED と区別される)。
      if (!opts.modes.includes('token')) throw new AppError('FORBIDDEN', 403, 'token not allowed for this route');
      // best-effort・非ブロッキング(auth-security.md「last_used_at 更新」)。この書き込みが失敗しても
      // 認証済みリクエストの処理は落とさない(すでに認証は成功しているため、ここで例外にしない)。
      try {
        await deps.storage.touchTokenLastUsed(token.id, deps.now(), TOKEN_LAST_USED_THRESHOLD_MS);
      } catch (err) {
        console.warn(JSON.stringify({ level: 'warn', msg: 'touchTokenLastUsed failed (best-effort, ignored)', detail: String(err) }));
      }
      c.set('actor', { kind: 'token', token });
      await next();
      return;
    }

    // Bearer が無い場合、このルートがそもそもセッション認証を許可しないなら Cookie の中身すら見ずに 401。
    if (!opts.modes.includes('session')) throw new AppError('UNAUTHORIZED', 401, 'authentication required');

    const raw = getCookie(c, SESSION_COOKIE);
    const sid = raw ? await deps.auth.verifySignedSessionId(raw) : null; // 三段AND 1) 署名検証
    const session = sid ? await deps.storage.getSession(sid) : null; // 三段AND 2) DB 存在確認
    if (!session) throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    if (session.expiresAt <= deps.now()) {
      // 三段AND 3) 未失効。超過セッションは検出時に行削除する(auth-security.md「検証フロー」不変条件)。
      await deps.storage.deleteSession(session.id);
      throw new AppError('UNAUTHORIZED', 401, 'session expired');
    }

    // org はまだ判明していないため scope なしの内部専用メソッドで解決する(storage/interface.ts の
    // getUserById の JSDoc 参照。authn ミドルウェア専用・API ハンドラでは使用禁止 = GC-5 の唯一の例外)。
    const user = await deps.storage.getUserById(session.userId);
    if (!user) throw new AppError('UNAUTHORIZED', 401, 'authentication required');
    if (opts.minRole && ROLE_RANK[user.role as Role] < ROLE_RANK[opts.minRole]) {
      throw new AppError('FORBIDDEN', 403, 'insufficient role');
    }
    c.set('actor', { kind: 'user', user, sessionId: session.id });
    await next();
  };
}
