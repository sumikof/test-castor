// tests/integration/ui-auth.test.ts
// task-17-brief.md「UI 基盤 + 認証画面(S-01 セットアップ / S-02 ログイン)」SSR スモークテスト。
// docs/screens/auth/S-01-setup.md・S-02-login.md・docs/screens.md「共通レイアウト」・スペック
// D-13-1/2/5/8 と1:1で対応させる(GC-1)。実 D1(miniflare binding)+ 固定クロック + 低イテレーション
// Auth を使う(tests/integration/helpers.ts。tests/integration/auth.test.ts と同じハーネス)。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  makeTestApp, wipe, cookieHeader, setupAndLogin, loginAs, DEFAULT_SETUP_BODY, type TestApp,
} from './helpers';
import { requirePageAuth } from '../../src/http/middleware/page-auth';

/** application/x-www-form-urlencoded の POST リクエスト共通オプション(UI フォームは JSON を送らない)。 */
function formReq(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  };
}

/** HTML 文字列から data-testid を持つタグ全体(属性の出現順に依存しない)を抜き出す。 */
function findTag(html: string, testid: string): string {
  const re = new RegExp(`<[a-zA-Z][^>]*data-testid="${testid}"[^>]*>`);
  const m = html.match(re);
  if (!m) throw new Error(`data-testid="${testid}" を持つタグが見つからない\n---\n${html}`);
  return m[0];
}
function hasTag(html: string, testid: string): boolean {
  return new RegExp(`data-testid="${testid}"`).test(html);
}
function attrValue(tag: string, attr: string): string | null {
  const m = tag.match(new RegExp(`${attr}="([^"]*)"`));
  return m?.[1] ?? null;
}
/** data-testid を持つタグの「開始タグ〜次の同系終了タグ手前」までのテキスト内容(エラーメッセージ確認用)。 */
function tagText(html: string, testid: string): string {
  const openMatch = html.match(new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)[^>]*data-testid="${testid}"[^>]*>`));
  if (!openMatch) throw new Error(`data-testid="${testid}" を持つタグが見つからない`);
  const tagName = openMatch[1];
  const startIdx = (openMatch.index ?? 0) + openMatch[0].length;
  const endIdx = html.indexOf(`</${tagName}>`, startIdx);
  if (endIdx === -1) throw new Error(`data-testid="${testid}" の終了タグ </${tagName}> が見つからない`);
  return html.slice(startIdx, endIdx);
}

async function createViewerAndLogin(ctx: TestApp, adminCtx: { jar: Record<string, string>; csrf?: string }) {
  const email = 'viewer@example.com';
  const password = 'viewer-pass-1';
  const res = await ctx.app.request('/api/v1/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookieHeader(adminCtx.jar),
      'x-csrf-token': adminCtx.csrf ?? '',
    },
    body: JSON.stringify({ email, password, display_name: 'Viewer One', role: 'viewer' }),
  });
  if (res.status !== 201) throw new Error(`viewer作成に失敗: ${res.status} ${await res.text()}`);
  return loginAs(ctx.app, email, password);
}

describe('SSR: UI 基盤 + 認証画面(S-01/S-02)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec);
  });

  describe('GET /(D-13-1/8 の振り分け)', () => {
    it('Organization が0件 → /setup へ302', async () => {
      const res = await ctx.app.request('/', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/setup');
    });

    it('Organization は存在するがセッション無し → /login へ302', async () => {
      await setupAndLogin(ctx.app); // org作成のみが目的(戻り値のセッションは使わない)
      const res = await ctx.app.request('/', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login');
    });

    it('有効なセッションあり → /projects へ302', async () => {
      const { jar } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/', { headers: { Cookie: cookieHeader(jar) }, redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/projects');
    });
  });

  describe('GET /setup(S-01 表示条件・要素カタログ)', () => {
    it('Organization が0件 → 200、S-01 の全 data-testid を含む(GC-8)', async () => {
      const res = await ctx.app.request('/setup');
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(tagText(html, 'setup-title')).toBe('TMS セットアップ');
      for (const testid of [
        'setup-org-name', 'setup-admin-email', 'setup-admin-password',
        'setup-admin-password-confirm', 'setup-admin-display-name', 'setup-submit',
      ]) {
        expect(hasTag(html, testid)).toBe(true);
      }
      // 初期状態(全フィールド空): 送信ボタンは disabled(S-01「状態バリエーション」)。
      expect(findTag(html, 'setup-submit')).toContain('disabled');
      // 共通レイアウトの資産配線(app.css / htmx.min.js)。
      expect(html).toContain('href="/app.css"');
      expect(html).toContain('src="/htmx.min.js"');
      // フォームは _csrf hidden を必ず含む(D-09)。
      expect(html).toMatch(/<input type="hidden" name="_csrf" value="[^"]+"/);
    });

    it('Organization が既に存在する → /login へ302(画面は表示されない)', async () => {
      await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/setup', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login');
    });

    it('GET のたびに csrf Cookie が発行され、hidden _csrf の値と一致する', async () => {
      const res = await ctx.app.request('/setup');
      const setCookies = res.headers.getSetCookie();
      const csrfCookie = setCookies.find((c) => c.startsWith('csrf='));
      expect(csrfCookie).toBeDefined();
      const csrfValue = csrfCookie!.split(';', 1)[0]!.split('=')[1];

      const html = await res.text();
      const hiddenMatch = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"/);
      expect(hiddenMatch?.[1]).toBe(csrfValue);
    });
  });

  describe('POST /setup(S-01 フォーム送信)', () => {
    it('正常値 → organization+admin user が作成され、303で /login?flash=setup_complete へ', async () => {
      const res = await ctx.app.request('/setup', formReq({
        organization_name: DEFAULT_SETUP_BODY.organization_name,
        admin_email: DEFAULT_SETUP_BODY.admin_email,
        admin_password: DEFAULT_SETUP_BODY.admin_password,
        admin_password_confirm: DEFAULT_SETUP_BODY.admin_password,
        admin_display_name: DEFAULT_SETUP_BODY.admin_display_name,
      }));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/login?flash=setup_complete');

      expect(await ctx.storage.countOrganizations()).toBe(1);
      const created = await ctx.storage.findUserForLogin(DEFAULT_SETUP_BODY.admin_email);
      expect(created?.role).toBe('admin');
      expect(created?.displayName).toBe(DEFAULT_SETUP_BODY.admin_display_name);
    });

    it('パスワード確認が不一致 → 200 + setup-admin-password-confirm-error に「パスワードが一致しません」、組織は作成されない', async () => {
      const res = await ctx.app.request('/setup', formReq({
        organization_name: DEFAULT_SETUP_BODY.organization_name,
        admin_email: DEFAULT_SETUP_BODY.admin_email,
        admin_password: DEFAULT_SETUP_BODY.admin_password,
        admin_password_confirm: 'totally-different-1',
        admin_display_name: DEFAULT_SETUP_BODY.admin_display_name,
      }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'setup-admin-password-confirm-error')).toBe('パスワードが一致しません');
      expect(await ctx.storage.countOrganizations()).toBe(0);
    });

    it('パスワードが8文字未満 → 200 + setup-admin-password-error に「パスワードは8文字以上で入力してください」', async () => {
      const res = await ctx.app.request('/setup', formReq({
        organization_name: DEFAULT_SETUP_BODY.organization_name,
        admin_email: DEFAULT_SETUP_BODY.admin_email,
        admin_password: '1234567',
        admin_password_confirm: '1234567',
        admin_display_name: DEFAULT_SETUP_BODY.admin_display_name,
      }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'setup-admin-password-error')).toBe('パスワードは8文字以上で入力してください');
      expect(await ctx.storage.countOrganizations()).toBe(0);
    });

    it('組織名が空文字 → 200 + setup-org-name-error に「組織名を入力してください」(入力済みの他フィールドは再表示される)', async () => {
      const res = await ctx.app.request('/setup', formReq({
        organization_name: '',
        admin_email: DEFAULT_SETUP_BODY.admin_email,
        admin_password: DEFAULT_SETUP_BODY.admin_password,
        admin_password_confirm: DEFAULT_SETUP_BODY.admin_password,
        admin_display_name: DEFAULT_SETUP_BODY.admin_display_name,
      }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'setup-org-name-error')).toBe('組織名を入力してください');
      expect(attrValue(findTag(html, 'setup-admin-email'), 'value')).toBe(DEFAULT_SETUP_BODY.admin_email);
      expect(await ctx.storage.countOrganizations()).toBe(0);
    });

    it('管理者メールが不正な形式 → 200 + setup-admin-email-error に「有効なメールアドレスを入力してください」', async () => {
      const res = await ctx.app.request('/setup', formReq({
        organization_name: DEFAULT_SETUP_BODY.organization_name,
        admin_email: 'not-an-email',
        admin_password: DEFAULT_SETUP_BODY.admin_password,
        admin_password_confirm: DEFAULT_SETUP_BODY.admin_password,
        admin_display_name: DEFAULT_SETUP_BODY.admin_display_name,
      }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'setup-admin-email-error')).toBe('有効なメールアドレスを入力してください');
      expect(await ctx.storage.countOrganizations()).toBe(0);
    });

    it('表示名が空文字 → 200 + setup-admin-display-name-error に「表示名を入力してください」', async () => {
      const res = await ctx.app.request('/setup', formReq({
        organization_name: DEFAULT_SETUP_BODY.organization_name,
        admin_email: DEFAULT_SETUP_BODY.admin_email,
        admin_password: DEFAULT_SETUP_BODY.admin_password,
        admin_password_confirm: DEFAULT_SETUP_BODY.admin_password,
        admin_display_name: '',
      }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'setup-admin-display-name-error')).toBe('表示名を入力してください');
      expect(await ctx.storage.countOrganizations()).toBe(0);
    });

    it('既に Organization が存在する状態(競合)→ 303で /login?flash=setup_already_complete、二重作成されない', async () => {
      await setupAndLogin(ctx.app); // 1件目の組織を作る
      const res = await ctx.app.request('/setup', formReq({
        organization_name: 'Another Org',
        admin_email: 'someone-else@example.com',
        admin_password: 'another-pass-1',
        admin_password_confirm: 'another-pass-1',
        admin_display_name: 'Someone Else',
      }));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/login?flash=setup_already_complete');
      expect(await ctx.storage.countOrganizations()).toBe(1); // 2件目は作られない
    });

    it('?flash=setup_already_complete → toast に「セットアップは既に完了しています」(S-01のエラートースト文言)', async () => {
      await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/login?flash=setup_already_complete');
      const html = await res.text();
      expect(tagText(html, 'toast')).toBe('セットアップは既に完了しています');
      expect(findTag(html, 'toast')).toContain('toast-error');
    });
  });

  describe('GET /login(S-02 表示条件・要素カタログ)', () => {
    it('Organization が0件 → /setup へ302', async () => {
      const res = await ctx.app.request('/login', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/setup');
    });

    it('未ログイン → 200、S-02 の全 data-testid を含む(GC-8)', async () => {
      await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/login');
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(tagText(html, 'login-title')).toBe('TMS ログイン');
      for (const testid of ['login-logo', 'login-email', 'login-password', 'login-submit', 'login-forgot-password']) {
        expect(hasTag(html, testid)).toBe(true);
      }
      expect(findTag(html, 'login-submit')).toContain('disabled');

      // D-13-2: 「パスワードを忘れた場合」はリンクではなくヒント文言(未実装の S-03 に導線を張らない)。
      const forgotTag = findTag(html, 'login-forgot-password');
      expect(forgotTag).not.toMatch(/^<a /);
      expect(forgotTag).not.toContain('href=');
      expect(tagText(html, 'login-forgot-password')).toBe('パスワードを忘れた場合は管理者にお問い合わせください');
    });

    it('ログイン済み → /projects へ302', async () => {
      const { jar } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/login', { headers: { Cookie: cookieHeader(jar) }, redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/projects');
    });

    it('?flash=session_expired → toast に文言表示', async () => {
      await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/login?flash=session_expired');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'toast')).toBe('セッションが失効しました。再度ログインしてください');
    });

    it('?flash=setup_complete → toast に「セットアップが完了しました。ログインしてください」', async () => {
      await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/login?flash=setup_complete');
      const html = await res.text();
      expect(tagText(html, 'toast')).toBe('セットアップが完了しました。ログインしてください');
    });
  });

  describe('POST /login(S-02 フォーム送信)', () => {
    it('成功 → 303で /projects へ + session/csrf の Set-Cookie 2本(属性込み)', async () => {
      await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/login', formReq({
        email: DEFAULT_SETUP_BODY.admin_email,
        password: DEFAULT_SETUP_BODY.admin_password,
      }));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/projects');

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
    });

    it('パスワード誤り → 200 + login-error に統一メッセージ(存在有無を漏らさない)', async () => {
      await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/login', formReq({
        email: DEFAULT_SETUP_BODY.admin_email,
        password: 'totally-wrong-pw',
      }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'login-error')).toBe('メールアドレスまたはパスワードが正しくありません');
      // S-02「状態バリエーション」認証失敗: パスワードフィールドはクリアされる(値を再表示しない)。
      expect(attrValue(findTag(html, 'login-password'), 'value')).toBe('');
      // メールアドレスは再入力の手間を省くため保持する(ドキュメントは明記していない実装判断)。
      expect(attrValue(findTag(html, 'login-email'), 'value')).toBe(DEFAULT_SETUP_BODY.admin_email);
    });

    it('未知 email も同じ login-error 文言(統一メッセージ)', async () => {
      await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/login', formReq({
        email: 'nobody-registered@example.com',
        password: 'whatever-1',
      }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'login-error')).toBe('メールアドレスまたはパスワードが正しくありません');
    });

    it('誤パスワードを5回試行 → 6回目は200 + login-error にレート制限文言(D-14)', async () => {
      await setupAndLogin(ctx.app);
      for (let i = 0; i < 5; i += 1) {
        const res = await ctx.app.request('/login', formReq({
          email: DEFAULT_SETUP_BODY.admin_email,
          password: 'wrong-password',
        }));
        expect(res.status).toBe(200);
      }
      const blocked = await ctx.app.request('/login', formReq({
        email: DEFAULT_SETUP_BODY.admin_email,
        password: 'wrong-password',
      }));
      expect(blocked.status).toBe(200);
      const html = await blocked.text();
      expect(tagText(html, 'login-error')).toBe('ログイン試行回数の上限に達しました。しばらくしてから再度お試しください');
    });
  });

  describe('POST /logout', () => {
    it('有効なセッション+CSRF → 303で /login へ、以後セッションは無効化される', async () => {
      const { jar, csrf } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/logout', {
        method: 'POST',
        headers: { Cookie: cookieHeader(jar), 'x-csrf-token': csrf ?? '' },
      });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/login');

      // セッション無効化の確認: 同じ Cookie で GET / を叩くと /login へ(/projects ではなく)戻る。
      const rootRes = await ctx.app.request('/', { headers: { Cookie: cookieHeader(jar) }, redirect: 'manual' });
      expect(rootRes.status).toBe(302);
      expect(rootRes.headers.get('location')).toBe('/login');
    });

    it('CSRFトークン無し → 403(セッションは維持されたまま)', async () => {
      const { jar } = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/logout', { method: 'POST', headers: { Cookie: cookieHeader(jar) } });
      expect(res.status).toBe(403);

      const rootRes = await ctx.app.request('/', { headers: { Cookie: cookieHeader(jar) }, redirect: 'manual' });
      expect(rootRes.headers.get('location')).toBe('/projects'); // セッションはまだ有効
    });
  });

  describe('requirePageAuth (middleware/page-auth.ts。Task 18以降が使う共通ガードの直接検証)', () => {
    it('セッション無し → /login?flash=session_expired へ302', async () => {
      ctx.app.get('/__test/session-required', requirePageAuth(), (c) => c.text('ok'));
      const res = await ctx.app.request('/__test/session-required', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?flash=session_expired');
    });

    it('ロール不足(minRole:admin、viewer でアクセス)→ 403 HTML(page-403-title/page-403-message)', async () => {
      ctx.app.get('/__test/admin-only', requirePageAuth({ minRole: 'admin' }), (c) => c.text('ok'));
      const admin = await setupAndLogin(ctx.app);
      const viewer = await createViewerAndLogin(ctx, admin);

      const res = await ctx.app.request('/__test/admin-only', { headers: { Cookie: cookieHeader(viewer.jar) } });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(tagText(html, 'page-403-title')).toBe('アクセスできません');
      expect(hasTag(html, 'page-403-message')).toBe(true);
    });

    it('十分なロール(admin)→ next() が呼ばれ、実際のハンドラが実行される', async () => {
      ctx.app.get('/__test/admin-only-2', requirePageAuth({ minRole: 'admin' }), (c) => c.text('ok'));
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/__test/admin-only-2', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    });
  });
});
