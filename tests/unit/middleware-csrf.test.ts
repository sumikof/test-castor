// tests/unit/middleware-csrf.test.ts
// csrfProtect(): D-09(HttpOnly Cookie + サーバー埋込型 double-submit)。
// POST/PATCH/DELETE/PUT で session actor は Cookie値とX-CSRF-Token(またはフォームの_csrf)の一致を必須とする。
// token actor は対象外。GET は対象外(auth-security.md「GETは副作用なし」)。
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createBetterSqlite3Storage } from '../../src/storage/adapters/better-sqlite3';
import { createWebcryptoAuth } from '../../src/auth/webcrypto-auth';
import { requireAuth } from '../../src/http/middleware/authn';
import { csrfProtect, CSRF_COOKIE, sessionCookieHeader, SESSION_COOKIE, COOKIE_ATTRS } from '../../src/http/middleware/csrf';
import { errorMiddleware } from '../../src/http/middleware/error';
import type { AppDeps } from '../../src/http/app';
import type { Storage, OrgScope } from '../../src/storage/interface';

const auth = createWebcryptoAuth({ signingKeys: { k1: 's' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
const NOW = 1_700_000_000_000;

function testConfig(): AppDeps['config'] {
  return {
    sessionTtlMs: 604_800_000, signingKeys: { k1: 's' }, activeKeyId: 'k1', pbkdf2Iterations: 1000,
    loginRateLimit: { windowMs: 900_000, max: 5 }, syncRateLimit: { windowMs: 60_000, max: 120 },
    observationRetentionMs: 7_776_000_000, identityTtlMs: 7_776_000_000,
  };
}
function allowAll() { return { limit: async () => ({ allowed: true }) } };

async function makeCtx() {
  const { storage } = createBetterSqlite3Storage(':memory:');
  const deps: AppDeps = { storage, auth, now: () => NOW, config: testConfig(), loginLimiter: allowAll(), syncLimiter: allowAll() };
  const app = new Hono<any>();
  app.use('*', async (c, next) => { c.set('deps', deps); await next(); });
  app.onError(errorMiddleware);
  const mutating = requireAuth({ modes: ['session', 'token'], minRole: 'viewer' });
  app.get('/x', mutating, (c) => c.json({ ok: true }));
  app.post('/x', mutating, csrfProtect(), (c) => c.json({ ok: true }));
  app.patch('/x', mutating, csrfProtect(), (c) => c.json({ ok: true }));
  app.delete('/x', mutating, csrfProtect(), (c) => c.json({ ok: true }));
  app.put('/x', mutating, csrfProtect(), (c) => c.json({ ok: true }));
  // csrfProtect が requireAuth なしで呼ばれても落ちない(actor 未設定への防御)ことの確認用
  app.post('/no-auth', csrfProtect(), (c) => c.json({ ok: true }));
  return { app, storage };
}

async function setupOrg(storage: Storage, orgName: string) {
  const r = await storage.setupOrganization({
    orgName, adminEmail: `admin-${orgName}@example.com`, adminPasswordHash: 'x', adminDisplayName: 'Admin', now: NOW,
  });
  return { organizationId: r.organization.id, admin: r.user };
}
async function sessionAndCsrf(storage: Storage, userId: string) {
  const sid = auth.newSessionId();
  await storage.createSession({ id: sid, userId, expiresAt: NOW + 1000, createdAt: NOW });
  const signed = await auth.signSessionId(sid);
  const csrf = auth.newCsrfToken();
  return { cookie: `session=${signed}; csrf=${csrf}`, csrf };
}
async function issueToken(storage: Storage, scope: OrgScope, pid: string) {
  const plain = auth.newApiToken();
  const hash = await auth.hashApiToken(plain);
  await storage.createApiToken(scope, pid, 'tok', hash, NOW);
  return plain;
}

describe('middleware/csrf: session actor の状態変更メソッド(POST/PATCH/DELETE/PUT)', () => {
  let ctx: Awaited<ReturnType<typeof makeCtx>>;
  beforeEach(async () => { ctx = await makeCtx(); });

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])('%s: CSRF Cookie も header も無い → 403 FORBIDDEN', async (method) => {
    const scope = await setupOrg(ctx.storage, `org-${method}-none`);
    const sid = auth.newSessionId();
    await ctx.storage.createSession({ id: sid, userId: scope.admin.id, expiresAt: NOW + 1000, createdAt: NOW });
    const signed = await auth.signSessionId(sid);
    const res = await ctx.app.request('/x', { method, headers: { Cookie: `session=${signed}` } });
    expect(res.status).toBe(403);
    expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
  });

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])('%s: CSRF Cookie はあるが X-CSRF-Token ヘッダが無い → 403', async (method) => {
    const scope = await setupOrg(ctx.storage, `org-${method}-hdrmissing`);
    const { cookie } = await sessionAndCsrf(ctx.storage, scope.admin.id);
    const res = await ctx.app.request('/x', { method, headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])('%s: X-CSRF-Token がCookie値と不一致 → 403', async (method) => {
    const scope = await setupOrg(ctx.storage, `org-${method}-mismatch`);
    const { cookie } = await sessionAndCsrf(ctx.storage, scope.admin.id);
    const res = await ctx.app.request('/x', { method, headers: { Cookie: cookie, 'x-csrf-token': 'totally-different-value' } });
    expect(res.status).toBe(403);
    expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
  });

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])('%s: X-CSRF-Token がCookie値と一致 → 200(通過)', async (method) => {
    const scope = await setupOrg(ctx.storage, `org-${method}-ok`);
    const { cookie, csrf } = await sessionAndCsrf(ctx.storage, scope.admin.id);
    const res = await ctx.app.request('/x', { method, headers: { Cookie: cookie, 'x-csrf-token': csrf } });
    expect(res.status).toBe(200);
  });

  it('フォーム送信(application/x-www-form-urlencoded)の _csrf フィールドが一致 → 200', async () => {
    const scope = await setupOrg(ctx.storage, 'org-form-ok');
    const { cookie, csrf } = await sessionAndCsrf(ctx.storage, scope.admin.id);
    const body = new URLSearchParams({ _csrf: csrf, other: 'field' });
    const res = await ctx.app.request('/x', {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
  });

  it('フォーム送信の _csrf フィールドが不一致 → 403', async () => {
    const scope = await setupOrg(ctx.storage, 'org-form-bad');
    const { cookie } = await sessionAndCsrf(ctx.storage, scope.admin.id);
    const body = new URLSearchParams({ _csrf: 'wrong-value' });
    const res = await ctx.app.request('/x', {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    expect(res.status).toBe(403);
  });

  it('X-CSRF-Token ヘッダがあればフォームの _csrf より優先される', async () => {
    const scope = await setupOrg(ctx.storage, 'org-form-header-priority');
    const { cookie, csrf } = await sessionAndCsrf(ctx.storage, scope.admin.id);
    const body = new URLSearchParams({ _csrf: 'wrong-value-in-form' });
    const res = await ctx.app.request('/x', {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
  });

  it('GET は CSRF 検証対象外(Cookie/header 無しでも 200)', async () => {
    const scope = await setupOrg(ctx.storage, 'org-get-exempt');
    const sid = auth.newSessionId();
    await ctx.storage.createSession({ id: sid, userId: scope.admin.id, expiresAt: NOW + 1000, createdAt: NOW });
    const signed = await auth.signSessionId(sid);
    const res = await ctx.app.request('/x', { headers: { Cookie: `session=${signed}` } });
    expect(res.status).toBe(200);
  });
});

describe('middleware/csrf: token actor は CSRF 検証の対象外(D-09)', () => {
  let ctx: Awaited<ReturnType<typeof makeCtx>>;
  beforeEach(async () => { ctx = await makeCtx(); });

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])('%s: 有効な Bearer token なら CSRF Cookie/header 無しでも 200', async (method) => {
    const scope = await setupOrg(ctx.storage, `org-token-${method}`);
    const project = await ctx.storage.createProject(scope, { name: 'p' }, NOW);
    const plain = await issueToken(ctx.storage, scope, project.id);
    const res = await ctx.app.request('/x', { method, headers: { Authorization: `Bearer ${plain}` } });
    expect(res.status).toBe(200);
  });
});

describe('middleware/csrf: 防御的動作(actor 未設定でもクラッシュしない)', () => {
  it('requireAuth を経由していないルートで csrfProtect を呼んでも例外にならず next() する', async () => {
    const { app } = await makeCtx();
    const res = await app.request('/no-auth', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('middleware/csrf: 定数・ヘルパのエクスポート', () => {
  it('SESSION_COOKIE / CSRF_COOKIE の Cookie名', () => {
    expect(SESSION_COOKIE).toBe('session');
    expect(CSRF_COOKIE).toBe('csrf');
  });

  it('COOKIE_ATTRS: HttpOnly; Secure; SameSite=Lax; Path=/ に対応する属性', () => {
    expect(COOKIE_ATTRS).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  });

  it('sessionCookieHeader: "session=<value>; HttpOnly; Secure; SameSite=Lax; Path=/" を返す', () => {
    expect(sessionCookieHeader('abc123')).toBe('session=abc123; HttpOnly; Secure; SameSite=Lax; Path=/');
  });
});
