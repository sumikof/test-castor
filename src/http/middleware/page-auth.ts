// src/http/middleware/page-auth.ts
// UI ページ用の認証ガード(task-17-brief.md「UI タスク共通事項」)。src/http/middleware/authn.ts の
// requireAuth と同型の三段AND(署名検証 → DB 存在確認 → expires_at > now)を用いるが、失敗時の扱いが
// API(401/403 を JSON で throw)と異なる:
//   - 未認証・失効セッション → 例外を投げず `/login?flash=session_expired` へ 302 リダイレクト
//   - ロール不足(403 相当)→ エラーページを描画(JSON ではなく HTML)
// UI ルートはセッション認証のみを扱う(衛星トークンの Bearer 認証は UI から到達しない)ため、
// requireAuth のように modes:['session','token'] を選べるようにはしない。
import type { MiddlewareHandler, Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { ROLE_RANK } from '../app';
import type { Role } from '../../schemas/enums';
import type { UserRow } from '../../storage/schema';
import { SESSION_COOKIE, CSRF_COOKIE, COOKIE_ATTRS } from './csrf';
import { renderForbiddenPage } from '../ui/layout';

export interface PageSession {
  user: UserRow;
  sessionId: string;
}

/**
 * 三段AND のセッション解決のみを行い、成否をリダイレクトせず返す(non-throwing)。
 * GET /、GET /setup、GET /login のように「ログイン済みかどうかで分岐したいが、未ログインは
 * エラーではない」ページが requirePageAuth を経由せずに使う。requirePageAuth 自体もこれを使う。
 */
export async function getPageSession(c: Context<AppEnv>): Promise<PageSession | null> {
  const deps = c.get('deps');
  const raw = getCookie(c, SESSION_COOKIE);
  const sid = raw ? await deps.auth.verifySignedSessionId(raw) : null; // 三段AND 1) 署名検証
  const session = sid ? await deps.storage.getSession(sid) : null; // 三段AND 2) DB 存在確認
  if (!session) return null;
  if (session.expiresAt <= deps.now()) {
    // 三段AND 3) 未失効。超過セッションは検出時に行削除する(authn.ts と同じ不変条件)。
    await deps.storage.deleteSession(session.id);
    return null;
  }
  const user = await deps.storage.getUserById(session.userId);
  if (!user) return null;
  return { user, sessionId: session.id };
}

/**
 * UI ページ保護ミドルウェア。401 相当 → `/login?flash=session_expired` へ 302。
 * 403 相当(minRole 不足)→ HTML エラーページを描画(JSON は返さない)。
 */
export function requirePageAuth(opts: { minRole?: Role } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await getPageSession(c);
    if (!session) return c.redirect('/login?flash=session_expired', 302);

    const { user, sessionId } = session;
    if (opts.minRole && ROLE_RANK[user.role as Role] < ROLE_RANK[opts.minRole]) {
      // レビュー指摘の修正: csrf 無しで renderForbiddenPage を呼ぶと GlobalHeader のログアウト
      // フォームに `_csrf=""` が埋め込まれ、403 画面からのログアウトが必ず csrfProtect() に弾かれる
      // (この 403 は認証済み user 前提のため GlobalHeader は必ず描画される)。ensureCsrfCookie は
      // 既存 Cookie があればそれを再利用するだけなので、ここで呼んでも通常の GET フォームページと
      // 同じ契約(値を変えない)を壊さない。
      const csrf = await ensureCsrfCookie(c);
      return renderForbiddenPage(c, user, csrf);
    }
    c.set('actor', { kind: 'user', user, sessionId });
    await next();
  };
}

/**
 * GET で描画するフォームページが常に有効な CSRF Cookie/値のペアを持てるようにする(D-09)。
 * 既に Cookie があればそれを再利用し(値は変えない)、無ければ新規発行して Set-Cookie する。
 * setup/login のような未認証ページでも、フォームの hidden `_csrf` に埋め込む値が必要なため使う
 * (csrfProtect() 自体は session actor が無いこれらのルートでは no-op のため、ここで発行する値は
 * 検証には使われないが、UI タスク共通事項の「フォームは _csrf を必ず含む」規約を満たすために埋め込む)。
 */
export async function ensureCsrfCookie(c: Context<AppEnv>): Promise<string> {
  const deps = c.get('deps');
  const existing = getCookie(c, CSRF_COOKIE);
  if (existing) return existing;
  const token = deps.auth.newCsrfToken();
  setCookie(c, CSRF_COOKIE, token, COOKIE_ATTRS);
  return token;
}
