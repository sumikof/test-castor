// tests/integration/tokens.test.ts
// API トークン管理 API(docs/apis/tokens.md)の統合テスト(task-11-brief.md「振る舞い」を1行ずつ検証する)。
// auth-security.md「API トークン認証」「平文の隔離」「認証・認可ミドルウェア執行仕様(能力マトリクス)」と
// 1:1で対応させる(GC-1)。実 D1(miniflare binding)+ 固定クロックを使う(tests/integration/helpers.ts)。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  makeTestApp, wipe, cookieHeader, setupAndLogin, loginAs, createProject, issueToken, FIXED_NOW, type TestApp,
} from './helpers';

/** JSON ボディ付きリクエストの共通オプションを組み立てる(既存の統合テストと同じ規約)。 */
function jsonReq(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** admin セッションで editor/viewer ユーザーを作成しログインする(projects.test.ts と同じ規約をローカル化)。 */
async function loginAsRole(
  ctx: TestApp,
  admin: { jar: Record<string, string>; csrf?: string },
  role: 'editor' | 'viewer',
  email: string,
) {
  await ctx.app.request(
    '/api/v1/users',
    jsonReq('POST', { email, password: `${role}-pass-1`, display_name: role, role }, {
      Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '',
    }),
  );
  return loginAs(ctx.app, email, `${role}-pass-1`);
}

describe('統合: API トークン管理 API', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec); // D1 はテスト間で状態が残るため毎回ワイプする
  });

  describe('POST /api/v1/projects/:pid/tokens(apis/tokens.md)', () => {
    it('admin: 201 {id,name,token,created_at} + Cache-Control: no-store。token は tms_ プレフィックスの平文', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens`,
        jsonReq('POST', { name: 'discovery-satellite-prod' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(201);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json<any>();
      expect(body).toEqual({
        id: expect.any(String),
        name: 'discovery-satellite-prod',
        token: expect.stringMatching(/^tms_/),
        created_at: FIXED_NOW,
      });
      // docs 記載の4フィールドのみ(token_hash 等の余計なフィールドが紛れ込んでいないこと)
      expect(Object.keys(body).sort()).toEqual(['created_at', 'id', 'name', 'token']);
    });

    it('editor: 403 FORBIDDEN(admin 限定)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const editor = await loginAsRole(ctx, admin, 'editor', 'editor@example.com');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens`,
        jsonReq('POST', { name: 'blocked' }, { Cookie: cookieHeader(editor.jar), 'x-csrf-token': editor.csrf ?? '' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('viewer: 403 FORBIDDEN(admin 限定)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer@example.com');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens`,
        jsonReq('POST', { name: 'blocked' }, { Cookie: cookieHeader(viewer.jar), 'x-csrf-token': viewer.csrf ?? '' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('name が空文字 → 422 VALIDATION_FAILED', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens`,
        jsonReq('POST', { name: '' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(422);
      expect((await res.json<any>()).error.code).toBe('VALIDATION_FAILED');
    });

    it('他 org の :pid → 404(存在隠蔽。2つ目の org を setupOrganization で直接作って検証)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const otherOrg = await ctx.storage.setupOrganization({
        orgName: 'Other Org', adminEmail: 'other-admin-post@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin', now: FIXED_NOW,
      });
      const otherProject = await ctx.storage.createProject(
        { organizationId: otherOrg.organization.id }, { name: 'other-org-project' }, FIXED_NOW,
      );

      const res = await ctx.app.request(
        `/api/v1/projects/${otherProject.id}/tokens`,
        jsonReq('POST', { name: 'x' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/projects/:pid/tokens(apis/tokens.md)', () => {
    it('0件: 200 {items:[]}', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');

      const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      expect(await res.json<any>()).toEqual({ items: [] });
    });

    it('発行済みトークンを一覧: 平文・ハッシュを含まず id/name/created_at/revoked_at/last_used_at のみ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const issueRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens`,
        jsonReq('POST', { name: 'discovery-ci' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      const issued = await issueRes.json<any>();

      const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toEqual({
        id: issued.id,
        name: 'discovery-ci',
        created_at: FIXED_NOW,
        revoked_at: null,
        last_used_at: null,
      });
      expect(Object.keys(body.items[0]).sort()).toEqual(['created_at', 'id', 'last_used_at', 'name', 'revoked_at']);
      // 平文の隔離(auth-security.md): レスポンス全体をシリアライズしても平文トークンが一切含まれないこと
      expect(JSON.stringify(body)).not.toContain(issued.token);
    });

    it('editor: 403 FORBIDDEN(admin 限定)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const editor = await loginAsRole(ctx, admin, 'editor', 'editor-get@example.com');

      const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, { headers: { Cookie: cookieHeader(editor.jar) } });
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('viewer: 403 FORBIDDEN(admin 限定。B2)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-get@example.com');

      const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, { headers: { Cookie: cookieHeader(viewer.jar) } });
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it(
      '有効な Bearer トークンで叩くと 403 FORBIDDEN(トークン管理は session 専用 = 能力マトリクス「禁止 → 403」)。' +
        'Task 13 で GET /api/v1/projects/:pid/testcases(参照系 GET)が実装されれば、同じ Bearer トークンで' +
        'そちらには到達できる想定(衛星トークンの到達可能範囲 = 自 project の参照系 GET のみ)',
      async () => {
        const admin = await setupAndLogin(ctx.app);
        const project = await createProject(ctx.app, admin, 'payment-service');
        const plaintext = await issueToken(ctx.app, admin, project.body.id, 'discovery-ci');

        const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, { headers: { Authorization: `Bearer ${plaintext}` } });
        expect(res.status).toBe(403);
        const body = await res.json<any>();
        expect(body.error.code).toBe('FORBIDDEN');
        expect(JSON.stringify(body)).not.toContain(plaintext); // 平文の隔離: エラーボディにも一切含めない
      },
    );

    it('他 org の :pid → 404(存在隠蔽)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const otherOrg = await ctx.storage.setupOrganization({
        orgName: 'Other Org', adminEmail: 'other-admin-get@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin', now: FIXED_NOW,
      });
      const otherProject = await ctx.storage.createProject(
        { organizationId: otherOrg.organization.id }, { name: 'other-org-project' }, FIXED_NOW,
      );

      const res = await ctx.app.request(`/api/v1/projects/${otherProject.id}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /api/v1/projects/:pid/tokens/:id(apis/tokens.md)', () => {
    it('admin: 200 {id,name,revoked_at} でソフト失効', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const issueRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens`,
        jsonReq('POST', { name: 'discovery-ci' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      const issued = await issueRes.json<any>();
      ctx.advance(1000);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens/${issued.id}`,
        jsonReq('DELETE', undefined, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body).toEqual({ id: issued.id, name: 'discovery-ci', revoked_at: FIXED_NOW + 1000 });
    });

    it('冪等: 再失効しても最初の revoked_at を返す(時刻が進んでも上書きされない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const issueRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens`,
        jsonReq('POST', { name: 'discovery-ci' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      const issued = await issueRes.json<any>();

      const first = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens/${issued.id}`,
        jsonReq('DELETE', undefined, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(first.status).toBe(200);
      const firstBody = await first.json<any>();

      ctx.advance(5000);

      const second = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens/${issued.id}`,
        jsonReq('DELETE', undefined, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(second.status).toBe(200);
      const secondBody = await second.json<any>();
      expect(secondBody).toEqual(firstBody); // 完全に同一(revoked_at も含め最初の失効結果のまま)
    });

    it('失効後はそのトークンの Bearer 認証が 401(認証述語: revoked_at IS NULL から除外される。403 ではない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const plaintext = await issueToken(ctx.app, admin, project.body.id, 'discovery-ci');

      // 失効前: 認証(真正性)は通るが token 管理ルートには到達禁止 = 403(能力マトリクス)
      const before = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, { headers: { Authorization: `Bearer ${plaintext}` } });
      expect(before.status).toBe(403);

      const list = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } });
      const tokenId = (await list.json<any>()).items[0].id;
      const revokeRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens/${tokenId}`,
        jsonReq('DELETE', undefined, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(revokeRes.status).toBe(200);

      // 失効後: そもそも認証述語(WHERE token_hash=? AND revoked_at IS NULL)にヒットしない = 401
      const after = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, { headers: { Authorization: `Bearer ${plaintext}` } });
      expect(after.status).toBe(401);
      const afterBody = await after.json<any>();
      expect(afterBody.error.code).toBe('UNAUTHORIZED');
      expect(JSON.stringify(afterBody)).not.toContain(plaintext); // 平文の隔離: エラーボディにも含めない
    });

    it('存在しない :id → 404', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens/00000000-0000-0000-0000-000000000000`,
        jsonReq('DELETE', undefined, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });

    it('editor: 403 FORBIDDEN(admin 限定)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const issueRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens`,
        jsonReq('POST', { name: 'discovery-ci' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      const issued = await issueRes.json<any>();
      const editor = await loginAsRole(ctx, admin, 'editor', 'editor-delete@example.com');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens/${issued.id}`,
        jsonReq('DELETE', undefined, { Cookie: cookieHeader(editor.jar), 'x-csrf-token': editor.csrf ?? '' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('viewer: 403 FORBIDDEN(admin 限定。B2)、トークンは失効しない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const issueRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens`,
        jsonReq('POST', { name: 'keep-alive' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      const issued = await issueRes.json<any>();
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-delete@example.com');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens/${issued.id}`,
        jsonReq('DELETE', undefined, { Cookie: cookieHeader(viewer.jar), 'x-csrf-token': viewer.csrf ?? '' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');

      // 識別: 失効していない(admin の一覧で当該 id の revoked_at が null のまま)
      const listRes = await ctx.app.request(`/api/v1/projects/${project.body.id}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } });
      const listBody = await listRes.json<any>();
      const row = listBody.items.find((t: any) => t.id === issued.id);
      expect(row.revoked_at).toBeNull();
    });

    it('他 org の :pid → 404(存在隠蔽。トークンは他 org の storage 経由で直接作成)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const otherOrg = await ctx.storage.setupOrganization({
        orgName: 'Other Org', adminEmail: 'other-admin-delete@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin', now: FIXED_NOW,
      });
      const otherProject = await ctx.storage.createProject(
        { organizationId: otherOrg.organization.id }, { name: 'other-org-project' }, FIXED_NOW,
      );
      const otherScope = { organizationId: otherOrg.organization.id };
      const otherToken = await ctx.storage.createApiToken(otherScope, otherProject.id, 'their-token', 'unused-hash', FIXED_NOW);

      const res = await ctx.app.request(
        `/api/v1/projects/${otherProject.id}/tokens/${otherToken.id}`,
        jsonReq('DELETE', undefined, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');

      // 実際には失効していないことも確認する(他 org の scope からは元のまま存在する)
      const stillActive = await ctx.storage.listApiTokens(otherScope, otherProject.id);
      expect(stillActive[0]?.revokedAt).toBeNull();
    });
  });

  describe('storage 直検証: findApiTokenByHash(auth-security.md「トークン保存・照合」)', () => {
    it('発行した平文をハッシュ化すると、その値で findApiTokenByHash が解決する(DB にはハッシュのみ保存)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const issueRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/tokens`,
        jsonReq('POST', { name: 'discovery-ci' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      const issued = await issueRes.json<any>();

      const hash = await ctx.deps.auth.hashApiToken(issued.token);
      const resolved = await ctx.storage.findApiTokenByHash(hash);
      expect(resolved).not.toBeNull();
      expect(resolved?.id).toBe(issued.id);
      expect(resolved?.name).toBe('discovery-ci');
      expect(resolved?.organizationId).toBeDefined();
      expect(resolved?.tokenHash).toBe(hash);
      expect(resolved?.tokenHash).not.toBe(issued.token); // 平文とハッシュは別物(saltなしSHA-256)
    });

    it('存在しないハッシュは null', async () => {
      const resolved = await ctx.storage.findApiTokenByHash('deadbeef'.repeat(8));
      expect(resolved).toBeNull();
    });
  });
});
