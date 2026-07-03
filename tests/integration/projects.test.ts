// tests/integration/projects.test.ts
// プロジェクト API(docs/apis/projects.md)の統合テスト(task-10-brief.md「振る舞い」を1行ずつ検証する)。
// docs/screens/main/S-06-project-list.md・スペック D-05(testcase_count)と1:1で対応させる(GC-1)。
// 実 D1(miniflare binding)+ 固定クロックを使う(tests/integration/helpers.ts)。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  makeTestApp, wipe, cookieHeader, setupAndLogin, loginAs, createProject, FIXED_NOW, type TestApp,
} from './helpers';

/** JSON ボディ付きリクエストの共通オプションを組み立てる(既存の統合テストと同じ規約)。 */
function jsonReq(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe('統合: プロジェクト API', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec); // D1 はテスト間で状態が残るため毎回ワイプする
  });

  describe('GET /api/v1/projects(apis/projects.md)', () => {
    it('プロジェクト0件: 200 {items:[]}', async () => {
      const { jar } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/api/v1/projects', { headers: { Cookie: cookieHeader(jar) } });
      expect(res.status).toBe(200);
      expect(await res.json<any>()).toEqual({ items: [] });
    });

    it('作成直後: 各アイテムに testcase_count=0(D-05)を含み、created_at 昇順で並ぶ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const first = await createProject(ctx.app, admin, 'payment-service');
      expect(first.res.status).toBe(201);
      ctx.advance(1000);
      const second = await createProject(ctx.app, admin, 'user-service');
      expect(second.res.status).toBe(201);

      const res = await ctx.app.request('/api/v1/projects', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.items).toHaveLength(2);
      expect(body.items.map((p: any) => p.name)).toEqual(['payment-service', 'user-service']); // created_at asc
      expect(body.items[0]).toMatchObject({ id: first.body.id, testcase_count: 0, name: 'payment-service' });
      expect(body.items[1]).toMatchObject({ id: second.body.id, testcase_count: 0, name: 'user-service' });
    });

    it('viewer でも 200(viewer 以上の全ロールが閲覧可)', async () => {
      const admin = await setupAndLogin(ctx.app);
      await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'viewer@example.com', password: 'viewer-pass-1', display_name: 'Viewer', role: 'viewer' }, {
          Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '',
        }),
      );
      const viewerLogin = await loginAs(ctx.app, 'viewer@example.com', 'viewer-pass-1');
      expect(viewerLogin.res.status).toBe(200);

      const res = await ctx.app.request('/api/v1/projects', { headers: { Cookie: cookieHeader(viewerLogin.jar) } });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/v1/projects(apis/projects.md)', () => {
    it('admin: 201。レスポンスは docs 記載の5フィールドのみ(testcase_count を含まない)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(
        '/api/v1/projects',
        jsonReq('POST', { name: 'payment-service', repo_url: 'https://github.com/example/payment' }, {
          Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '',
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json<any>();
      expect(body).toEqual({
        id: expect.any(String),
        name: 'payment-service',
        repo_url: 'https://github.com/example/payment',
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
      });
    });

    it('repo_url 省略可: 未指定なら null で作成される', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(
        '/api/v1/projects',
        jsonReq('POST', { name: 'no-repo' }, { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' }),
      );
      expect(res.status).toBe(201);
      expect((await res.json<any>()).repo_url).toBeNull();
    });

    it('editor: 403 FORBIDDEN(admin 限定)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'editor@example.com', password: 'editor-pass-1', display_name: 'Editor', role: 'editor' }, {
          Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '',
        }),
      );
      const editorLogin = await loginAs(ctx.app, 'editor@example.com', 'editor-pass-1');
      const res = await ctx.app.request(
        '/api/v1/projects',
        jsonReq('POST', { name: 'blocked' }, { Cookie: cookieHeader(editorLogin.jar), 'x-csrf-token': editorLogin.csrf ?? '' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('viewer: 403 FORBIDDEN(admin 限定)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'viewer2@example.com', password: 'viewer2-pass-1', display_name: 'Viewer2', role: 'viewer' }, {
          Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '',
        }),
      );
      const viewerLogin = await loginAs(ctx.app, 'viewer2@example.com', 'viewer2-pass-1');
      const res = await ctx.app.request(
        '/api/v1/projects',
        jsonReq('POST', { name: 'blocked' }, { Cookie: cookieHeader(viewerLogin.jar), 'x-csrf-token': viewerLogin.csrf ?? '' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('repo_url が http/https でない → 422 VALIDATION_FAILED', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(
        '/api/v1/projects',
        jsonReq('POST', { name: 'bad-url', repo_url: 'ftp://example.com/repo' }, {
          Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '',
        }),
      );
      expect(res.status).toBe(422);
      const body = await res.json<any>();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'repo_url' })]));
    });
  });

  describe('PATCH /api/v1/projects/:pid(apis/projects.md)', () => {
    it('admin: name 更新 → 200、updated_at が進み、レスポンスに testcase_count を含まない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const created = await createProject(ctx.app, admin, 'old-name');
      ctx.advance(500);

      const res = await ctx.app.request(
        `/api/v1/projects/${created.body.id}`,
        jsonReq('PATCH', { name: 'new-name' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body).toEqual({
        id: created.body.id,
        name: 'new-name',
        repo_url: created.body.repo_url,
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW + 500,
      });
    });

    it('repo_url: null を明示指定するとクリアされる(PATCH セマンティクス)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const created = await createProject(ctx.app, admin, 'with-repo', 'https://github.com/example/repo');
      expect(created.body.repo_url).toBe('https://github.com/example/repo');

      const res = await ctx.app.request(
        `/api/v1/projects/${created.body.id}`,
        jsonReq('PATCH', { repo_url: null }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.repo_url).toBeNull();
      expect(body.name).toBe('with-repo'); // 未指定キーは不変(PATCH セマンティクス)
    });

    it('editor: 403 FORBIDDEN(admin 限定)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const created = await createProject(ctx.app, admin, 'target');
      await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'editor2@example.com', password: 'editor2-pass-1', display_name: 'Editor2', role: 'editor' }, {
          Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '',
        }),
      );
      const editorLogin = await loginAs(ctx.app, 'editor2@example.com', 'editor2-pass-1');
      const res = await ctx.app.request(
        `/api/v1/projects/${created.body.id}`,
        jsonReq('PATCH', { name: 'hacked' }, { Cookie: cookieHeader(editorLogin.jar), 'x-csrf-token': editorLogin.csrf ?? '' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('他 org の :pid → 404(存在隠蔽。2つ目の org を setupOrganization で直接作って検証)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const otherOrg = await ctx.storage.setupOrganization({
        orgName: 'Other Org', adminEmail: 'other-admin@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin', now: FIXED_NOW,
      });
      const otherProject = await ctx.storage.createProject(
        { organizationId: otherOrg.organization.id }, { name: 'other-org-project' }, FIXED_NOW,
      );

      const res = await ctx.app.request(
        `/api/v1/projects/${otherProject.id}`,
        jsonReq('PATCH', { name: 'hacked' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');

      // 実際に変更されていないことも確認する(自 org からは 404 のため getProject では見えないが、
      // 他 org の scope からは正しく元の名前のまま存在する)
      const stillThere = await ctx.storage.getProject({ organizationId: otherOrg.organization.id }, otherProject.id);
      expect(stillThere?.name).toBe('other-org-project');
    });
  });
});
