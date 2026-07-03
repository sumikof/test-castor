// tests/unit/middleware-authn.test.ts
// requireAuth/resolveProject を tiny Hono app に装着し、better-sqlite3 storage + 実 Auth で
// task-7-brief.md の振る舞い表を1行ずつ検証する(三段AND・能力マトリクス・IDOR 404/403 は
// auth-security.md の記述どおり)。署名 Cookie は実 Auth(auth.signSessionId)で組み立てる。
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createBetterSqlite3Storage } from '../../src/storage/adapters/better-sqlite3';
import { createWebcryptoAuth } from '../../src/auth/webcrypto-auth';
import { requireAuth } from '../../src/http/middleware/authn';
import { resolveProject } from '../../src/http/middleware/scope';
import { errorMiddleware } from '../../src/http/middleware/error';
import type { AppDeps } from '../../src/http/app';
import type { Storage, OrgScope } from '../../src/storage/interface';
import type { Role } from '../../src/schemas/enums';

const auth = createWebcryptoAuth({ signingKeys: { k1: 's' }, activeKeyId: 'k1', pbkdf2Iterations: 1000 });
const NOW = 1_700_000_000_000;

function testConfig(): AppDeps['config'] {
  return {
    sessionTtlMs: 604_800_000,
    signingKeys: { k1: 's' },
    activeKeyId: 'k1',
    pbkdf2Iterations: 1000,
    loginRateLimit: { windowMs: 900_000, max: 5 },
    syncRateLimit: { windowMs: 60_000, max: 120 },
    observationRetentionMs: 7_776_000_000,
    identityTtlMs: 7_776_000_000,
  };
}
function allowAll() {
  return { limit: async () => ({ allowed: true }) };
}

async function makeCtx() {
  const { storage, rawExec } = createBetterSqlite3Storage(':memory:');
  const deps: AppDeps = { storage, auth, now: () => NOW, config: testConfig(), loginLimiter: allowAll(), syncLimiter: allowAll() };
  const app = new Hono<any>();
  app.use('*', async (c, next) => { c.set('deps', deps); await next(); });
  app.onError(errorMiddleware);
  app.get('/whoami', requireAuth({ modes: ['session'], minRole: 'viewer' }), (c) => c.json({ id: (c.get('actor') as any).user.id }));
  app.get('/p/:pid/x', requireAuth({ modes: ['session', 'token'], minRole: 'viewer' }), resolveProject(), (c) => c.json({ pid: (c.get('project') as any).id }));
  app.post('/admin-only', requireAuth({ modes: ['session'], minRole: 'admin' }), (c) => c.json({ ok: true }));
  // 追加ルート(表の個別行を狙って検証するため。ブリーフの3例だけではカバーできない行がある):
  app.get('/token-only', requireAuth({ modes: ['token'] }), (c) => c.json({ ok: true })); // 「session actor だが modes が token のみ」用
  app.get('/token-admin-only', requireAuth({ modes: ['token'], minRole: 'admin' }), (c) => c.json({ ok: true })); // 「token actor の役割チェック」用(tokenにroleは無い)
  return { app, storage, rawExec };
}

// --- test fixtures -------------------------------------------------------
async function setupOrg(storage: Storage, orgName: string) {
  const r = await storage.setupOrganization({
    orgName, adminEmail: `admin-${orgName}@example.com`, adminPasswordHash: 'x', adminDisplayName: 'Admin', now: NOW,
  });
  return { organizationId: r.organization.id, admin: r.user };
}
async function makeUser(storage: Storage, scope: OrgScope, role: Role, email: string) {
  const u = await storage.createUser(scope, { email, passwordHash: 'x', displayName: email, role, now: NOW });
  if (u === 'email_taken') throw new Error('test setup: unexpected email_taken');
  return u;
}
async function cookieForNewSession(storage: Storage, userId: string, expiresAt: number) {
  const sid = auth.newSessionId();
  await storage.createSession({ id: sid, userId, expiresAt, createdAt: NOW });
  const signed = await auth.signSessionId(sid);
  return { sid, header: `session=${signed}` };
}
async function issueToken(storage: Storage, scope: OrgScope, pid: string, name = 'tok') {
  const plain = auth.newApiToken();
  const hash = await auth.hashApiToken(plain);
  const row = await storage.createApiToken(scope, pid, name, hash, NOW);
  return { plain, row };
}

describe('middleware/authn: 振る舞い表(auth-security.md 能力マトリクス・IDOR 404/403)', () => {
  let ctx: Awaited<ReturnType<typeof makeCtx>>;
  beforeEach(async () => { ctx = await makeCtx(); });

  describe('セッション認証: Cookie なし / 署名不正 / DB に無い / expires_at<=now → 401(失効行は削除)', () => {
    it('Cookie なし → 401 UNAUTHORIZED', async () => {
      const res = await ctx.app.request('/whoami');
      expect(res.status).toBe(401);
      expect((await res.json<any>()).error.code).toBe('UNAUTHORIZED');
    });

    it('署名不正(形式不正なゴミ値) → 401', async () => {
      const res = await ctx.app.request('/whoami', { headers: { Cookie: 'session=not-a-signed-value' } });
      expect(res.status).toBe(401);
      expect((await res.json<any>()).error.code).toBe('UNAUTHORIZED');
    });

    it('署名不正(改竄された署名) → 401', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const { header } = await cookieForNewSession(ctx.storage, scope.admin.id, NOW + 1000);
      const tampered = header.slice(0, -1) + (header.endsWith('A') ? 'B' : 'A');
      const res = await ctx.app.request('/whoami', { headers: { Cookie: tampered } });
      expect(res.status).toBe(401);
    });

    it('署名は正当だが DB に該当セッションが無い(未発行のid) → 401', async () => {
      const neverPersistedId = auth.newSessionId();
      const signed = await auth.signSessionId(neverPersistedId);
      const res = await ctx.app.request('/whoami', { headers: { Cookie: `session=${signed}` } });
      expect(res.status).toBe(401);
      expect((await res.json<any>()).error.code).toBe('UNAUTHORIZED');
    });

    it('expires_at <= now(失効セッション) → 401 かつ Session 行が削除される', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const { sid, header } = await cookieForNewSession(ctx.storage, scope.admin.id, NOW); // expiresAt === now → 失効(<=)
      expect(await ctx.storage.getSession(sid)).not.toBeNull();
      const res = await ctx.app.request('/whoami', { headers: { Cookie: header } });
      expect(res.status).toBe(401);
      expect((await res.json<any>()).error.code).toBe('UNAUTHORIZED');
      expect(await ctx.storage.getSession(sid)).toBeNull(); // 失効セッションは行削除
    });

    it('expires_at < now(過去に失効済み) → 401 かつ行削除', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const { sid, header } = await cookieForNewSession(ctx.storage, scope.admin.id, NOW - 1);
      const res = await ctx.app.request('/whoami', { headers: { Cookie: header } });
      expect(res.status).toBe(401);
      expect(await ctx.storage.getSession(sid)).toBeNull();
    });

    it('有効なセッション(expires_at > now) → 200、ユーザーIDが一致', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const { header } = await cookieForNewSession(ctx.storage, scope.admin.id, NOW + 1000);
      const res = await ctx.app.request('/whoami', { headers: { Cookie: header } });
      expect(res.status).toBe(200);
      expect(await res.json<any>()).toEqual({ id: scope.admin.id });
    });

    it('セッションの参照先ユーザーが存在しない(孤立セッション) → 401', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const ghost = await makeUser(ctx.storage, scope, 'viewer', 'ghost@example.com');
      const { header } = await cookieForNewSession(ctx.storage, ghost.id, NOW + 1000);
      // ユーザー行を直接削除して「セッションはあるがユーザーが無い」異常系(本来 FK で守られるが、
      // 移行期データ等の想定外状態への防御を確認するため一時的に FK を外して作る)を模擬する。
      await ctx.rawExec(`PRAGMA foreign_keys = OFF; DELETE FROM users WHERE id = '${ghost.id}'; PRAGMA foreign_keys = ON;`);
      const res = await ctx.app.request('/whoami', { headers: { Cookie: header } });
      expect(res.status).toBe(401);
    });
  });

  describe('トークン認証: Bearer 不正 / 失効済み → 401', () => {
    it('Bearer 不正(未発行トークン) → 401', async () => {
      const res = await ctx.app.request('/token-only', { headers: { Authorization: 'Bearer tms_never-issued-token-value-00000000000' } });
      expect(res.status).toBe(401);
      expect((await res.json<any>()).error.code).toBe('UNAUTHORIZED');
    });

    it('失効済みトークン(revoked_at 設定済み) → 401', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const project = await ctx.storage.createProject(scope, { name: 'p' }, NOW);
      const { plain, row } = await issueToken(ctx.storage, scope, project.id);
      await ctx.storage.revokeApiToken(scope, project.id, row.id, NOW);
      const res = await ctx.app.request('/token-only', { headers: { Authorization: `Bearer ${plain}` } });
      expect(res.status).toBe(401);
    });

    it('有効なトークン + token-only ルート → 200', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const project = await ctx.storage.createProject(scope, { name: 'p' }, NOW);
      const { plain } = await issueToken(ctx.storage, scope, project.id);
      const res = await ctx.app.request('/token-only', { headers: { Authorization: `Bearer ${plain}` } });
      expect(res.status).toBe(200);
    });

    it('有効なトークンで touchTokenLastUsed が呼ばれる(best-effort last_used_at 更新)', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const project = await ctx.storage.createProject(scope, { name: 'p' }, NOW);
      const { plain, row } = await issueToken(ctx.storage, scope, project.id);
      await ctx.app.request('/token-only', { headers: { Authorization: `Bearer ${plain}` } });
      const [after] = await ctx.storage.listApiTokens(scope, project.id);
      expect(after?.id).toBe(row.id);
      expect(after?.lastUsedAt).toBe(NOW);
    });

    it('touchTokenLastUsed が失敗しても認証済みリクエストは落ちない(best-effort・非ブロッキング。auth-security.md)', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const project = await ctx.storage.createProject(scope, { name: 'p' }, NOW);
      const { plain } = await issueToken(ctx.storage, scope, project.id);
      // touchTokenLastUsed だけが必ず失敗する Storage ラッパーを注入する(他のメソッドは実装へ委譲)。
      const flakyStorage: Storage = {
        ...ctx.storage,
        touchTokenLastUsed: async () => { throw new Error('simulated write failure'); },
      };
      const deps: AppDeps = { storage: flakyStorage, auth, now: () => NOW, config: testConfig(), loginLimiter: allowAll(), syncLimiter: allowAll() };
      const app = new Hono<any>();
      app.use('*', async (c, next) => { c.set('deps', deps); await next(); });
      app.onError(errorMiddleware);
      app.get('/token-only', requireAuth({ modes: ['token'] }), (c) => c.json({ ok: true }));
      const res = await app.request('/token-only', { headers: { Authorization: `Bearer ${plain}` } });
      expect(res.status).toBe(200); // 200のまま。500にならない
      expect(await res.json<any>()).toEqual({ ok: true });
    });
  });

  describe('能力マトリクス: 有効な token だが modes に token が無い → 403 FORBIDDEN(認証は通っているが禁止)', () => {
    it('/whoami (modes:[session]) に有効な Bearer token → 403 FORBIDDEN(401 ではない)', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const project = await ctx.storage.createProject(scope, { name: 'p' }, NOW);
      const { plain } = await issueToken(ctx.storage, scope, project.id);
      const res = await ctx.app.request('/whoami', { headers: { Authorization: `Bearer ${plain}` } });
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });
  });

  describe('能力マトリクス: session actor だが modes が token のみ → 401', () => {
    it('/token-only に有効な session Cookie(Bearer無し) → 401(Cookieの中身は検査すらされない)', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const { header } = await cookieForNewSession(ctx.storage, scope.admin.id, NOW + 1000);
      const res = await ctx.app.request('/token-only', { headers: { Cookie: header } });
      expect(res.status).toBe(401);
      expect((await res.json<any>()).error.code).toBe('UNAUTHORIZED');
    });

    it('無認証(Cookieも Bearer も無し)で /token-only → 401', async () => {
      const res = await ctx.app.request('/token-only');
      expect(res.status).toBe(401);
    });
  });

  describe('RBAC: role 不足(viewer/editor が admin ルート) → 403 FORBIDDEN', () => {
    it.each<[Role, number]>([
      ['viewer', 403],
      ['editor', 403],
      ['admin', 200],
    ])('role=%s で POST /admin-only → %i', async (role, expectedStatus) => {
      const scope = await setupOrg(ctx.storage, `org-${role}`);
      const user = role === 'admin' ? scope.admin : await makeUser(ctx.storage, scope, role, `u-${role}@example.com`);
      const { header } = await cookieForNewSession(ctx.storage, user.id, NOW + 1000);
      const res = await ctx.app.request('/admin-only', { method: 'POST', headers: { Cookie: header } });
      expect(res.status).toBe(expectedStatus);
      if (expectedStatus === 403) expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('minRole と同じ role(viewer が viewer ルート) → 200(閾値は以上)', async () => {
      const scope = await setupOrg(ctx.storage, 'orgViewerOk');
      const viewer = await makeUser(ctx.storage, scope, 'viewer', 'v@example.com');
      const { header } = await cookieForNewSession(ctx.storage, viewer.id, NOW + 1000);
      const res = await ctx.app.request('/whoami', { headers: { Cookie: header } });
      expect(res.status).toBe(200);
    });
  });

  describe('能力マトリクス: token actor の役割チェック(token に role は無い。modes:[token]を含むルートのみ到達可)', () => {
    it('/token-admin-only(modes:[token], minRole:admin) に有効な token → 200(roleチェックをバイパスする)', async () => {
      const scope = await setupOrg(ctx.storage, 'orgA');
      const project = await ctx.storage.createProject(scope, { name: 'p' }, NOW);
      const { plain } = await issueToken(ctx.storage, scope, project.id);
      const res = await ctx.app.request('/token-admin-only', { headers: { Authorization: `Bearer ${plain}` } });
      expect(res.status).toBe(200);
    });
  });

  describe('IDOR: session actor の :pid が自 org に無い → 404(存在隠蔽)', () => {
    it('他 org のプロジェクトIDでアクセス → 404 NOT_FOUND', async () => {
      const scopeA = await setupOrg(ctx.storage, 'orgA');
      const scopeB = await setupOrg(ctx.storage, 'orgB');
      const projectB = await ctx.storage.createProject(scopeB, { name: 'p-in-b' }, NOW);
      const { header } = await cookieForNewSession(ctx.storage, scopeA.admin.id, NOW + 1000);
      const res = await ctx.app.request(`/p/${projectB.id}/x`, { headers: { Cookie: header } });
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });

    it('存在しない pid → 404 NOT_FOUND(実在しないIDと他org所属IDが同一の404で区別不能)', async () => {
      const scopeA = await setupOrg(ctx.storage, 'orgA');
      const { header } = await cookieForNewSession(ctx.storage, scopeA.admin.id, NOW + 1000);
      const res = await ctx.app.request('/p/00000000-0000-0000-0000-000000000000/x', { headers: { Cookie: header } });
      expect(res.status).toBe(404);
    });

    it('自 org のプロジェクトIDでアクセス → 200', async () => {
      const scopeA = await setupOrg(ctx.storage, 'orgA');
      const projectA = await ctx.storage.createProject(scopeA, { name: 'p-in-a' }, NOW);
      const { header } = await cookieForNewSession(ctx.storage, scopeA.admin.id, NOW + 1000);
      const res = await ctx.app.request(`/p/${projectA.id}/x`, { headers: { Cookie: header } });
      expect(res.status).toBe(200);
      expect(await res.json<any>()).toEqual({ pid: projectA.id });
    });
  });

  describe('テナント境界: token actor の token.projectId !== :pid → 403 CROSS_TENANT', () => {
    it('別プロジェクトIDでアクセス → 403 CROSS_TENANT', async () => {
      const scopeA = await setupOrg(ctx.storage, 'orgA');
      const projectA1 = await ctx.storage.createProject(scopeA, { name: 'p1' }, NOW);
      const projectA2 = await ctx.storage.createProject(scopeA, { name: 'p2' }, NOW);
      const { plain } = await issueToken(ctx.storage, scopeA, projectA1.id);
      const res = await ctx.app.request(`/p/${projectA2.id}/x`, { headers: { Authorization: `Bearer ${plain}` } });
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('CROSS_TENANT');
    });

    it('token.projectId === :pid → 200', async () => {
      const scopeA = await setupOrg(ctx.storage, 'orgA');
      const projectA1 = await ctx.storage.createProject(scopeA, { name: 'p1' }, NOW);
      const { plain } = await issueToken(ctx.storage, scopeA, projectA1.id);
      const res = await ctx.app.request(`/p/${projectA1.id}/x`, { headers: { Authorization: `Bearer ${plain}` } });
      expect(res.status).toBe(200);
      expect(await res.json<any>()).toEqual({ pid: projectA1.id });
    });

    // 注: resolveProject() には projectId 一致後にも org スコープ付きで再取得し null なら CROSS_TENANT
    // にする二段目の防御(scope.ts 参照)があるが、findApiTokenByHash が apiTokens⋈projects の JOIN で
    // organizationId を導出する現行実装では、projectId が一致した時点でその project の org 不一致は
    // 構造的に発生しない(この二段目は defense-in-depth であり、通常のデータフローでは到達しない)。
  });
});
