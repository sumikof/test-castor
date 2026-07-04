// tests/integration/auth.test.ts
// セットアップ API + 認証 API の統合テスト(task-8-brief.md「振る舞い」表を1行ずつ検証する)。
// docs/apis/setup.md・docs/apis/auth.md・docs/auth-security.md・スペック D-05/D-08/D-09/D-14 の
// 記述と1:1で対応させる(GC-1)。実 D1(miniflare binding)+ 固定クロック + 低イテレーション Auth を
// 使う(tests/integration/helpers.ts)。
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestApp, wipe, cookiesFrom, cookieHeader, setupAndLogin, loginAs, DEFAULT_SETUP_BODY, FIXED_NOW, type TestApp } from './helpers';

/** JSON ボディ付きリクエストの共通オプションを組み立てる(既存 unit テストは app.request に直接 init を渡す規約)。 */
function jsonReq(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe('統合: setup + auth API', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec); // D1 はテスト間で状態が残るため毎回ワイプする(storage-contract.ts と同じ規約)
  });

  describe('POST /api/v1/setup(apis/setup.md)', () => {
    it('Organization が0件のとき: 201 で organization + admin user を単一操作で作成する(レスポンス仕様どおりのフィールドのみ)', async () => {
      const res = await ctx.app.request('/api/v1/setup', jsonReq('POST', DEFAULT_SETUP_BODY));
      expect(res.status).toBe(201);
      const body = await res.json<any>();
      expect(body).toEqual({
        organization: { id: expect.any(String), name: DEFAULT_SETUP_BODY.organization_name, created_at: FIXED_NOW },
        user: {
          id: expect.any(String),
          email: DEFAULT_SETUP_BODY.admin_email,
          display_name: DEFAULT_SETUP_BODY.admin_display_name,
          role: 'admin',
          created_at: FIXED_NOW,
        },
      });
    });

    it('既に Organization が存在する状態で再度 setup → 409 SETUP_ALREADY_COMPLETE', async () => {
      const first = await ctx.app.request('/api/v1/setup', jsonReq('POST', DEFAULT_SETUP_BODY));
      expect(first.status).toBe(201);

      const second = await ctx.app.request(
        '/api/v1/setup',
        jsonReq('POST', { ...DEFAULT_SETUP_BODY, admin_email: 'someone-else@example.com' }),
      );
      expect(second.status).toBe(409);
      const body = await second.json<any>();
      expect(body.error.code).toBe('SETUP_ALREADY_COMPLETE');
    });

    it('admin_password が7文字(下限8文字未満) → 422 VALIDATION_FAILED、details に admin_password の path', async () => {
      const res = await ctx.app.request('/api/v1/setup', jsonReq('POST', { ...DEFAULT_SETUP_BODY, admin_password: '1234567' }));
      expect(res.status).toBe(422);
      const body = await res.json<any>();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'admin_password' })]));

      // バリデーション失敗時は組織が作られていないこと(副作用なし)も確認する
      expect(await ctx.storage.countOrganizations()).toBe(0);
    });
  });

  describe('POST /api/v1/auth/login(apis/auth.md)', () => {
    it('成功: session/csrf の Set-Cookie 2本(属性込み)+ user JSON を返し、users.last_login_at が更新される(storage直読)', async () => {
      await ctx.app.request('/api/v1/setup', jsonReq('POST', DEFAULT_SETUP_BODY));

      const res = await ctx.app.request(
        '/api/v1/auth/login',
        jsonReq('POST', { email: DEFAULT_SETUP_BODY.admin_email, password: DEFAULT_SETUP_BODY.admin_password }),
      );
      expect(res.status).toBe(200);

      const setCookies = res.headers.getSetCookie();
      expect(setCookies).toHaveLength(2);
      const sessionCookie = setCookies.find((c) => c.startsWith('session='));
      const csrfCookie = setCookies.find((c) => c.startsWith('csrf='));
      expect(sessionCookie).toBeDefined();
      expect(csrfCookie).toBeDefined();
      for (const cookie of [sessionCookie, csrfCookie]) {
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Path=/');
      }

      const body = await res.json<any>();
      expect(body).toEqual({
        user: {
          id: expect.any(String),
          email: DEFAULT_SETUP_BODY.admin_email,
          display_name: DEFAULT_SETUP_BODY.admin_display_name,
          role: 'admin',
        },
      });

      // last_login_at(D-05)が今回のログイン時刻で更新されていることを storage 直読で確認する
      const stored = await ctx.storage.getUserById(body.user.id);
      expect(stored?.lastLoginAt).toBe(FIXED_NOW);
    });

    it('未知 email と誤パスワードは完全に同一形状の 401 を返す(メールアドレスの存在有無を漏らさない)', async () => {
      await ctx.app.request('/api/v1/setup', jsonReq('POST', DEFAULT_SETUP_BODY));

      const unknownEmailRes = await ctx.app.request(
        '/api/v1/auth/login',
        jsonReq('POST', { email: 'nobody-registered@example.com', password: 'whatever-1' }),
      );
      const wrongPasswordRes = await ctx.app.request(
        '/api/v1/auth/login',
        jsonReq('POST', { email: DEFAULT_SETUP_BODY.admin_email, password: 'totally-wrong-pw' }),
      );

      expect(unknownEmailRes.status).toBe(401);
      expect(wrongPasswordRes.status).toBe(401);
      const unknownEmailBody = await unknownEmailRes.json<any>();
      const wrongPasswordBody = await wrongPasswordRes.json<any>();
      expect(unknownEmailBody.error.code).toBe('UNAUTHORIZED');
      expect(unknownEmailBody).toEqual(wrongPasswordBody); // 形状もメッセージも完全一致
    });

    it('誤パスワードを5回試行 → 6回目は429 + Retry-Afterヘッダ(D-14: 5失敗/15分)', async () => {
      await ctx.app.request('/api/v1/setup', jsonReq('POST', DEFAULT_SETUP_BODY));

      for (let i = 0; i < 5; i += 1) {
        const res = await ctx.app.request(
          '/api/v1/auth/login',
          jsonReq('POST', { email: DEFAULT_SETUP_BODY.admin_email, password: 'wrong-password' }),
        );
        expect(res.status).toBe(401);
      }

      const blocked = await ctx.app.request(
        '/api/v1/auth/login',
        jsonReq('POST', { email: DEFAULT_SETUP_BODY.admin_email, password: 'wrong-password' }),
      );
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBe('900'); // ceil(900_000ms窓 / 1000)、クロックは進めていない
      const body = await blocked.json<any>();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.retryable).toBe(true);
    });

    it('正しいパスワードの試行はconsumeしない: 4回失敗→成功→失敗でもまだ429にならない(5回消費で初めて429)', async () => {
      await ctx.app.request('/api/v1/setup', jsonReq('POST', DEFAULT_SETUP_BODY));

      for (let i = 0; i < 4; i += 1) {
        const res = await ctx.app.request(
          '/api/v1/auth/login',
          jsonReq('POST', { email: DEFAULT_SETUP_BODY.admin_email, password: 'wrong-password' }),
        );
        expect(res.status).toBe(401);
      }

      // 5回目の試行(正しいパスワード) → 成功し、かつ枠を消費しない
      const success = await ctx.app.request(
        '/api/v1/auth/login',
        jsonReq('POST', { email: DEFAULT_SETUP_BODY.admin_email, password: DEFAULT_SETUP_BODY.admin_password }),
      );
      expect(success.status).toBe(200);

      // 6回目(誤パスワード) → 消費済みはまだ4回分なのでブロックされず 401(429ではない)
      const stillNotBlocked = await ctx.app.request(
        '/api/v1/auth/login',
        jsonReq('POST', { email: DEFAULT_SETUP_BODY.admin_email, password: 'wrong-password' }),
      );
      expect(stillNotBlocked.status).toBe(401);

      // 7回目(誤パスワード) → ここで消費が5回に達し、今度こそ429(カウントが正しく効いていることの確認)
      const nowBlocked = await ctx.app.request(
        '/api/v1/auth/login',
        jsonReq('POST', { email: DEFAULT_SETUP_BODY.admin_email, password: 'wrong-password' }),
      );
      expect(nowBlocked.status).toBe(429);
    });
  });

  describe('GET /api/v1/auth/me(apis/auth.md)', () => {
    it('Cookie なし → 401 UNAUTHORIZED', async () => {
      const res = await ctx.app.request('/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect((await res.json<any>()).error.code).toBe('UNAUTHORIZED');
    });

    it('有効なセッション → 200 で {id,email,display_name,role,organization_id}', async () => {
      const { jar, user } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(jar) } });
      expect(res.status).toBe(200);

      const stored = await ctx.storage.getUserById(user.id);
      const body = await res.json<any>();
      expect(body).toEqual({
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        organization_id: stored?.organizationId,
      });
    });
  });

  describe('POST /api/v1/auth/logout(apis/auth.md)', () => {
    it('204(両Cookieを Max-Age=0 で削除)→ 直後の /me は401になる(セッション行が削除される)', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);

      const res = await ctx.app.request('/api/v1/auth/logout', {
        method: 'POST',
        headers: { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' },
      });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      const setCookies = res.headers.getSetCookie();
      expect(setCookies).toHaveLength(2);
      for (const cookie of setCookies) expect(cookie).toContain('Max-Age=0');

      const meRes = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(jar) } });
      expect(meRes.status).toBe(401);
    });

    it('CSRFトークン無しの logout → 403(セッションは維持されたまま)', async () => {
      const { jar } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/api/v1/auth/logout', { method: 'POST', headers: { Cookie: cookieHeader(jar) } });
      expect(res.status).toBe(403);

      const meRes = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(jar) } });
      expect(meRes.status).toBe(200); // セッションは無効化されていない
    });
  });

  describe('PATCH /api/v1/auth/password(apis/auth.md)', () => {
    it('current_password が不一致 → 401 UNAUTHORIZED', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(
        '/api/v1/auth/password',
        jsonReq('PATCH', { current_password: 'totally-wrong', new_password: 'brand-new-pass-1' }, {
          Cookie: cookieHeader(jar),
          'x-csrf-token': csrf ?? '',
        }),
      );
      expect(res.status).toBe(401);
      expect((await res.json<any>()).error.code).toBe('UNAUTHORIZED');
    });

    it('x-csrf-token 無しの PATCH → 403(D-09 二次防御)', async () => {
      const { jar } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(
        '/api/v1/auth/password',
        jsonReq('PATCH', { current_password: DEFAULT_SETUP_BODY.admin_password, new_password: 'brand-new-pass-1' }, {
          Cookie: cookieHeader(jar),
        }),
      );
      expect(res.status).toBe(403);
    });

    it('new_password が129文字(上限128超) → 422 VALIDATION_FAILED(D-06。B6)、変更されない', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(
        '/api/v1/auth/password',
        jsonReq('PATCH', { current_password: DEFAULT_SETUP_BODY.admin_password, new_password: 'a'.repeat(129) }, {
          Cookie: cookieHeader(jar),
          'x-csrf-token': csrf ?? '',
        }),
      );
      expect(res.status).toBe(422);
      const body = await res.json<any>();
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'new_password' })]));

      // 識別: 変更されていない(旧パスワードで引き続きログイン可)
      const oldLogin = await loginAs(ctx.app, DEFAULT_SETUP_BODY.admin_email, DEFAULT_SETUP_BODY.admin_password);
      expect(oldLogin.res.status).toBe(200);
    });

    it('成功: 200 {message:"password_changed"}、他セッションは401に無効化・自セッションは200のまま、旧PWでlogin不可・新PWでlogin可', async () => {
      const first = await setupAndLogin(ctx.app); // セッションA
      const second = await loginAs(ctx.app, DEFAULT_SETUP_BODY.admin_email, DEFAULT_SETUP_BODY.admin_password); // 同一ユーザーのセッションB
      expect(second.res.status).toBe(200);
      expect(second.jar.session).not.toBe(first.jar.session); // 異なるセッションであることの前提確認

      const NEW_PASSWORD = 'brand-new-pass-1';
      const changeRes = await ctx.app.request(
        '/api/v1/auth/password',
        jsonReq('PATCH', { current_password: DEFAULT_SETUP_BODY.admin_password, new_password: NEW_PASSWORD }, {
          Cookie: cookieHeader(first.jar),
          'x-csrf-token': first.csrf ?? '',
        }),
      );
      expect(changeRes.status).toBe(200);
      expect(await changeRes.json<any>()).toEqual({ message: 'password_changed' });

      // 自セッション(A)は維持される
      const meA = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(first.jar) } });
      expect(meA.status).toBe(200);

      // 他セッション(B)は無効化される
      const meB = await ctx.app.request('/api/v1/auth/me', { headers: { Cookie: cookieHeader(second.jar) } });
      expect(meB.status).toBe(401);

      // 旧パスワードでのログインは失敗する
      const oldLogin = await loginAs(ctx.app, DEFAULT_SETUP_BODY.admin_email, DEFAULT_SETUP_BODY.admin_password);
      expect(oldLogin.res.status).toBe(401);

      // 新パスワードでのログインは成功する
      const newLogin = await loginAs(ctx.app, DEFAULT_SETUP_BODY.admin_email, NEW_PASSWORD);
      expect(newLogin.res.status).toBe(200);
    });
  });
});
