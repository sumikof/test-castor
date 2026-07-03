// tests/integration/users.test.ts
// ユーザー管理 API(docs/apis/users.md)の統合テスト(task-9-brief.md「振る舞い」を1行ずつ検証する)。
// docs/screens/admin/S-18-user-list.md・S-19-user-create-edit.md・スペック D-05(last_login_at)/
// D-13-7(最後の admin 保護)と1:1で対応させる(GC-1)。実 D1(miniflare binding)+ 固定クロックを使う
// (tests/integration/helpers.ts)。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  makeTestApp, wipe, cookieHeader, setupAndLogin, loginAs, DEFAULT_SETUP_BODY, FIXED_NOW, type TestApp,
} from './helpers';

/** JSON ボディ付きリクエストの共通オプションを組み立てる(auth.test.ts と同じ規約)。 */
function jsonReq(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe('統合: ユーザー管理 API', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec); // D1 はテスト間で状態が残るため毎回ワイプする
  });

  describe('GET /api/v1/users(apis/users.md)', () => {
    it('admin: 200 {items:[...]}、各 item に last_login_at を含む(D-05。ログイン済みは日時・未ログインは null)', async () => {
      const { jar, csrf, user: admin } = await setupAndLogin(ctx.app);

      const createRes = await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'editor@example.com', password: 'editor-pass-1', display_name: 'Editor Jiro', role: 'editor' }, {
          Cookie: cookieHeader(jar),
          'x-csrf-token': csrf ?? '',
        }),
      );
      expect(createRes.status).toBe(201);

      const res = await ctx.app.request('/api/v1/users', { headers: { Cookie: cookieHeader(jar) } });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.items).toHaveLength(2);

      const adminItem = body.items.find((i: any) => i.id === admin.id);
      const editorItem = body.items.find((i: any) => i.email === 'editor@example.com');
      expect(adminItem).toMatchObject({ role: 'admin', last_login_at: FIXED_NOW }); // setupAndLogin でログイン済み
      expect(editorItem).toMatchObject({ role: 'editor', display_name: 'Editor Jiro', last_login_at: null }); // 未ログイン
    });

    it('editor: 403 FORBIDDEN(admin 限定)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'editor@example.com', password: 'editor-pass-1', display_name: 'Editor Jiro', role: 'editor' }, {
          Cookie: cookieHeader(jar),
          'x-csrf-token': csrf ?? '',
        }),
      );
      const editorLogin = await loginAs(ctx.app, 'editor@example.com', 'editor-pass-1');
      expect(editorLogin.res.status).toBe(200);

      const res = await ctx.app.request('/api/v1/users', { headers: { Cookie: cookieHeader(editorLogin.jar) } });
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });
  });

  describe('GET /api/v1/users/:id(apis/users.md)', () => {
    it('admin: 200 で単一ユーザーを返す', async () => {
      const { jar, user: admin } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(`/api/v1/users/${admin.id}`, { headers: { Cookie: cookieHeader(jar) } });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body).toMatchObject({ id: admin.id, email: admin.email, role: 'admin' });
    });

    it('他 org のユーザー ID → 404(存在隠蔽)', async () => {
      const { jar } = await setupAndLogin(ctx.app);
      const other = await ctx.storage.setupOrganization({
        orgName: 'Other Org 3', adminEmail: 'other-admin3@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin3', now: FIXED_NOW,
      });
      const res = await ctx.app.request(`/api/v1/users/${other.user.id}`, { headers: { Cookie: cookieHeader(jar) } });
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/users(apis/users.md)', () => {
    it('admin: 201 で作成 → 作成したユーザーの email/password でログイン可能(round-trip)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'sato@example.com', password: 'sato-pass-1', display_name: 'Sato Hanako', role: 'editor' }, {
          Cookie: cookieHeader(jar),
          'x-csrf-token': csrf ?? '',
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json<any>();
      expect(body).toEqual({
        id: expect.any(String),
        email: 'sato@example.com',
        display_name: 'Sato Hanako',
        role: 'editor',
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
        last_login_at: null,
      });

      const login = await loginAs(ctx.app, 'sato@example.com', 'sato-pass-1');
      expect(login.res.status).toBe(200);
      expect(login.user.email).toBe('sato@example.com');
    });

    it('editor: 403 FORBIDDEN(admin 限定)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'editor@example.com', password: 'editor-pass-1', display_name: 'Editor Jiro', role: 'editor' }, {
          Cookie: cookieHeader(jar),
          'x-csrf-token': csrf ?? '',
        }),
      );
      const editorLogin = await loginAs(ctx.app, 'editor@example.com', 'editor-pass-1');

      const res = await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'another@example.com', password: 'another-pass-1', display_name: 'Another', role: 'viewer' }, {
          Cookie: cookieHeader(editorLogin.jar),
          'x-csrf-token': editorLogin.csrf ?? '',
        }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('email 重複 → 422 VALIDATION_FAILED(details: [{path:"email",msg:"already exists"}])', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: DEFAULT_SETUP_BODY.admin_email, password: 'whatever-pass-1', display_name: 'Dup', role: 'editor' }, {
          Cookie: cookieHeader(jar),
          'x-csrf-token': csrf ?? '',
        }),
      );
      expect(res.status).toBe(422);
      const body = await res.json<any>();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.details).toEqual([{ path: 'email', msg: 'already exists' }]);
    });

    it('password が7文字(下限8文字未満) → 422 VALIDATION_FAILED(D-06)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'shortpw@example.com', password: '1234567', display_name: 'Short PW', role: 'editor' }, {
          Cookie: cookieHeader(jar),
          'x-csrf-token': csrf ?? '',
        }),
      );
      expect(res.status).toBe(422);
      const body = await res.json<any>();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'password' })]));
    });
  });

  describe('PATCH /api/v1/users/:id(apis/users.md)', () => {
    async function createUser(
      jar: Record<string, string>,
      csrf: string | undefined,
      overrides: Partial<{ email: string; password: string; display_name: string; role: string }> = {},
    ) {
      const body = { email: 'member@example.com', password: 'member-pass-1', display_name: 'Member', role: 'editor', ...overrides };
      const res = await ctx.app.request('/api/v1/users', jsonReq('POST', body, { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' }));
      return { res, body: await res.json<any>(), input: body };
    }

    it('role 変更 → 対象ユーザーの全セッションを無効化する(exceptなし。対象の旧Cookieは401化)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const created = await createUser(jar, csrf);
      expect(created.res.status).toBe(201);

      const targetLogin = await loginAs(ctx.app, created.input.email, created.input.password);
      expect(targetLogin.res.status).toBe(200);
      const meBefore = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(targetLogin.jar) } });
      expect(meBefore.status).toBe(200);

      const patchRes = await ctx.app.request(
        `/api/v1/users/${created.body.id}`,
        jsonReq('PATCH', { role: 'admin' }, { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' }),
      );
      expect(patchRes.status).toBe(200);
      expect((await patchRes.json<any>()).role).toBe('admin');

      const meAfter = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(targetLogin.jar) } });
      expect(meAfter.status).toBe(401); // 旧セッションは無効化される
    });

    it('display_name のみ変更 → セッションは無効化されない(role 未変更)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const created = await createUser(jar, csrf);
      const targetLogin = await loginAs(ctx.app, created.input.email, created.input.password);

      const patchRes = await ctx.app.request(
        `/api/v1/users/${created.body.id}`,
        jsonReq('PATCH', { display_name: 'Renamed' }, { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' }),
      );
      expect(patchRes.status).toBe(200);
      expect((await patchRes.json<any>()).display_name).toBe('Renamed');

      const me = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(targetLogin.jar) } });
      expect(me.status).toBe(200); // 無効化されない
    });

    it('admin が1人の状態で自分を editor に PATCH → 422(message: "cannot demote the last admin")(D-13-7)', async () => {
      const { jar, csrf, user: admin } = await setupAndLogin(ctx.app);

      const res = await ctx.app.request(
        `/api/v1/users/${admin.id}`,
        jsonReq('PATCH', { role: 'editor' }, { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' }),
      );
      expect(res.status).toBe(422);
      const body = await res.json<any>();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.message).toBe('cannot demote the last admin');

      const stored = await ctx.storage.getUserById(admin.id);
      expect(stored?.role).toBe('admin'); // 変更されていない

      const me = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(jar) } });
      expect(me.status).toBe(200); // セッションも維持される(拒否されたので副作用なし)
    });

    it('admin が2人いれば自分を editor に降格できる(200)。対象セッションは無効化される(exceptなし)', async () => {
      const { jar, csrf, user: admin1 } = await setupAndLogin(ctx.app);
      const secondAdmin = await createUser(jar, csrf, {
        email: 'admin2@example.com', password: 'admin2-pass-1', display_name: 'Admin Jiro', role: 'admin',
      });
      expect(secondAdmin.res.status).toBe(201);

      const res = await ctx.app.request(
        `/api/v1/users/${admin1.id}`,
        jsonReq('PATCH', { role: 'editor' }, { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' }),
      );
      expect(res.status).toBe(200);
      expect((await res.json<any>()).role).toBe('editor');

      // exceptなしなので、この降格を実行した本人(admin1)の旧セッションも無効化される
      const me = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(jar) } });
      expect(me.status).toBe(401);
    });

    it('他 org のユーザー ID への PATCH → 404(存在隠蔽)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const other = await ctx.storage.setupOrganization({
        orgName: 'Other Org', adminEmail: 'other-admin@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin', now: FIXED_NOW,
      });

      const res = await ctx.app.request(
        `/api/v1/users/${other.user.id}`,
        jsonReq('PATCH', { display_name: 'Hacked' }, { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' }),
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/users/:id/reset-password(apis/users.md)', () => {
    it('成功: 200 {message:"password_reset"}、対象の全セッション無効化・旧PW不可・新PW可', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const createRes = await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'target@example.com', password: 'old-pass-1', display_name: 'Target', role: 'editor' }, {
          Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '',
        }),
      );
      const created = await createRes.json<any>();
      const targetLogin = await loginAs(ctx.app, 'target@example.com', 'old-pass-1');
      expect(targetLogin.res.status).toBe(200);

      const resetRes = await ctx.app.request(
        `/api/v1/users/${created.id}/reset-password`,
        jsonReq('POST', { new_password: 'brand-new-pass-1' }, { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' }),
      );
      expect(resetRes.status).toBe(200);
      expect(await resetRes.json<any>()).toEqual({ message: 'password_reset' });

      const me = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(targetLogin.jar) } });
      expect(me.status).toBe(401); // 旧セッション無効化

      const oldLogin = await loginAs(ctx.app, 'target@example.com', 'old-pass-1');
      expect(oldLogin.res.status).toBe(401);

      const newLogin = await loginAs(ctx.app, 'target@example.com', 'brand-new-pass-1');
      expect(newLogin.res.status).toBe(200);
    });

    it('new_password が7文字 → 422 VALIDATION_FAILED(D-06)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const createRes = await ctx.app.request(
        '/api/v1/users',
        jsonReq('POST', { email: 'target2@example.com', password: 'old-pass-1', display_name: 'Target2', role: 'editor' }, {
          Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '',
        }),
      );
      const created = await createRes.json<any>();

      const res = await ctx.app.request(
        `/api/v1/users/${created.id}/reset-password`,
        jsonReq('POST', { new_password: '1234567' }, { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' }),
      );
      expect(res.status).toBe(422);
      expect((await res.json<any>()).error.code).toBe('VALIDATION_FAILED');
    });

    it('他 org のユーザー ID への reset-password → 404(存在隠蔽)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const other = await ctx.storage.setupOrganization({
        orgName: 'Other Org 2', adminEmail: 'other-admin2@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin2', now: FIXED_NOW,
      });

      const res = await ctx.app.request(
        `/api/v1/users/${other.user.id}/reset-password`,
        jsonReq('POST', { new_password: 'brand-new-pass-1' }, { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' }),
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });
  });
});
