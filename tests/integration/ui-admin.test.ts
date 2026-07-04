// tests/integration/ui-admin.test.ts
// task-21-brief.md「管理画面(S-16/S-17 トークン、S-18/S-19 ユーザー、S-20 プロフィール)」SSR スモークテスト。
// docs/screens/project-settings/S-16-api-token-list.md / S-17-token-issue-result.md、
// docs/screens/admin/S-18-user-list.md / S-19-user-create-edit.md / S-20-profile-password.md と
// 1:1で対応させる(GC-1)。tests/integration/ui-projects.test.ts と同じハーネス・ヘルパ規約を使う
// (各 ui-*.test.ts が HTML アサーションヘルパをローカルに複製する既存の規約に合わせる)。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  makeTestApp, wipe, cookieHeader, setupAndLogin, loginAs, createProject, issueToken, DEFAULT_SETUP_BODY,
  type TestApp,
} from './helpers';

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
/** data-testid を持つタグの「開始タグ〜次の同系終了タグ手前」までのテキスト内容(エラーメッセージ確認用)。
 * ネストした同名タグを含む要素には使わない(ui-projects.test.ts と同じ注意書き)。 */
function tagText(html: string, testid: string): string {
  const openMatch = html.match(new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)[^>]*data-testid="${testid}"[^>]*>`));
  if (!openMatch) throw new Error(`data-testid="${testid}" を持つタグが見つからない`);
  const tagName = openMatch[1];
  const startIdx = (openMatch.index ?? 0) + openMatch[0].length;
  const endIdx = html.indexOf(`</${tagName}>`, startIdx);
  if (endIdx === -1) throw new Error(`data-testid="${testid}" の終了タグ </${tagName}> が見つからない`);
  return html.slice(startIdx, endIdx);
}

/** POST /api/v1/users でロール指定のユーザーを作る(ログインはしない)。ui-projects.test.ts の
 * createUserAndLogin を「作成のみ」「任意の display_name」に一般化。 */
async function createUserApi(
  ctx: TestApp,
  adminCtx: { jar: Record<string, string>; csrf?: string },
  p: { email: string; password: string; displayName: string; role: 'admin' | 'editor' | 'viewer' },
) {
  const res = await ctx.app.request('/api/v1/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookieHeader(adminCtx.jar),
      'x-csrf-token': adminCtx.csrf ?? '',
    },
    body: JSON.stringify({ email: p.email, password: p.password, display_name: p.displayName, role: p.role }),
  });
  if (res.status !== 201) throw new Error(`createUserApi 失敗: ${res.status} ${await res.text()}`);
  return res.json<any>();
}

async function createUserAndLogin(
  ctx: TestApp,
  adminCtx: { jar: Record<string, string>; csrf?: string },
  p: { email: string; password: string; displayName: string; role: 'admin' | 'editor' | 'viewer' },
) {
  const body = await createUserApi(ctx, adminCtx, p);
  const login = await loginAs(ctx.app, p.email, p.password);
  return { body, login };
}

/** ログイン応答の user は toUserJson の絞り込み形({id,email,display_name,role}のみ)で organization_id を
 * 含まない(src/http/api/auth.ts の POST /login 参照)。ui-projects.test.ts の listProjectsAsAdmin と同じ
 * 規約で、Storage 直呼び出しに必要な OrgScope は findUserForLogin で改めて引く。 */
async function orgScopeOfAdmin(ctx: TestApp): Promise<{ organizationId: string }> {
  const user = await ctx.storage.findUserForLogin(DEFAULT_SETUP_BODY.admin_email);
  if (!user) throw new Error('admin user not found');
  return { organizationId: user.organizationId };
}

describe('SSR: 管理画面(S-16/S-17 トークン、S-18/S-19 ユーザー、S-20 プロフィール)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec);
  });

  // ============================================================
  // S-16/S-17: API トークン
  // ============================================================
  describe('GET /projects/:pid/tokens(S-16 一覧)', () => {
    it('admin・トークン0件 → 空状態メッセージ + 注釈 + テーブル非表示', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(`/projects/${project.body.id}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(tagText(html, 'token-list-title')).toBe('API トークン');
      expect(hasTag(html, 'token-table')).toBe(false);
      expect(tagText(html, 'token-list-empty')).toContain('APIトークンがありません');
      expect(hasTag(html, 'token-list-note')).toBe(true);
      expect(hasTag(html, 'token-issue-button')).toBe(true);
    });

    it('トークン2件(有効+失効済み、last_used_at 有無混在)→ 全列 + バッジ + 失効ボタンの表示条件(GC-8)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const pid = project.body.id;

      const usedToken = await issueToken(ctx.app, admin, pid, 'discovery-ci');
      // 実際に Bearer 認証で使用させ last_used_at を発生させる(未使用トークンとの対比データにする)。
      const useRes = await ctx.app.request(`/api/v1/projects/${pid}/testcases`, {
        headers: { authorization: `Bearer ${usedToken}` },
      });
      expect(useRes.status).toBe(200);

      await issueToken(ctx.app, admin, pid, 'test-gen-dev'); // 未使用のまま残す

      const listRes = await ctx.app.request(`/api/v1/projects/${pid}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } });
      const items = (await listRes.json<any>()).items as Array<{ id: string; name: string; revoked_at: number | null }>;
      const used = items.find((t) => t.name === 'discovery-ci')!;
      const unused = items.find((t) => t.name === 'test-gen-dev')!;

      // 3つ目を発行してすぐ失効させ、「失効済み」バッジのケースを作る。
      const revokeTarget = await issueToken(ctx.app, admin, pid, 'old-token');
      const revokedItems = (await (await ctx.app.request(`/api/v1/projects/${pid}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } })).json<any>()).items;
      const oldTokenId = revokedItems.find((t: any) => t.name === 'old-token').id;
      await ctx.app.request(`/api/v1/projects/${pid}/tokens/${oldTokenId}`, {
        method: 'DELETE',
        headers: { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' },
      });

      const res = await ctx.app.request(`/projects/${pid}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } });
      const html = await res.text();

      expect(hasTag(html, 'token-table')).toBe(true);
      expect(hasTag(html, 'token-list-empty')).toBe(false);
      // S-16 の列カタログ(token-name/token-created-at/...)は行ごとに一意化する必要があるため、
      // 既存の一覧画面群(project-name-{id} 等)と同じ規約で `{列名}-{id}` サフィックスを付与する。
      for (const base of ['token-name', 'token-created-at', 'token-last-used', 'token-status', 'token-actions']) {
        expect(hasTag(html, `${base}-${unused.id}`)).toBe(true);
      }
      expect(tagText(html, `token-name-${unused.id}`)).toBe('test-gen-dev');

      // 平文はどこにも含まれない(GET一覧には平文なし)。
      expect(html).not.toContain(usedToken);
      expect(html).not.toContain(revokeTarget);

      // 有効トークン: 未使用 → 「未使用」表示 + 失効ボタンあり。
      expect(tagText(html, `token-last-used-${unused.id}`)).toBe('未使用');
      expect(tagText(html, `token-status-${unused.id}`)).toContain('有効');
      expect(hasTag(html, `token-revoke-button-${unused.id}`)).toBe(true);

      // 使用済みトークン: last_used_at がフォーマットされて表示。
      expect(tagText(html, `token-last-used-${used.id}`)).not.toBe('未使用');
      expect(tagText(html, `token-status-${used.id}`)).toContain('有効');

      // 失効済みトークン: バッジが「失効済み」+ 失効ボタン非表示。
      expect(tagText(html, `token-status-${oldTokenId}`)).toContain('失効済み');
      expect(hasTag(html, `token-revoke-button-${oldTokenId}`)).toBe(false);
    });

    it('editor → 403 ページ(ブリーフ Step1 の必須シナリオ)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const editor = await createUserAndLogin(ctx, admin, { email: 'editor@example.com', password: 'editor-pass-1', displayName: 'Editor One', role: 'editor' });
      const res = await ctx.app.request(`/projects/${project.body.id}/tokens`, { headers: { Cookie: cookieHeader(editor.login.jar) } });
      expect(res.status).toBe(403);
      expect(tagText(await res.text(), 'page-403-title')).toBe('アクセスできません');
    });

    it('viewer → 403 ページ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const viewer = await createUserAndLogin(ctx, admin, { email: 'viewer@example.com', password: 'viewer-pass-1', displayName: 'Viewer One', role: 'viewer' });
      const res = await ctx.app.request(`/projects/${project.body.id}/tokens`, { headers: { Cookie: cookieHeader(viewer.login.jar) } });
      expect(res.status).toBe(403);
    });

    it('存在しない pid → 404 ページ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects/does-not-exist/tokens', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(404);
      expect(tagText(await res.text(), 'page-404-title')).toContain('見つかりません');
    });

    it('セッション無し → /login?flash=session_expired へ302', async () => {
      const res = await ctx.app.request('/projects/x/tokens', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?flash=session_expired');
    });
  });

  describe('GET /projects/:pid/tokens/new(S-17 ステップ1ダイアログ)', () => {
    it('admin + HX-Request → ダイアログフラグメントのみ + 全 testid(GC-8)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(`/projects/${project.body.id}/tokens/new`, {
        headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('<html');

      expect(tagText(html, 'token-issue-title')).toBe('トークン発行');
      for (const testid of ['token-issue-name-input', 'token-issue-cancel', 'token-issue-submit']) {
        expect(hasTag(html, testid)).toBe(true);
      }
      expect(html).toMatch(/<input type="hidden" name="_csrf" value="[^"]+"/);
      expect(findTag(html, 'token-issue-submit')).not.toMatch(/\bdisabled\b/);
    });

    it('admin + 非HX → S-16 一覧 + ダイアログを開いた状態のフルページ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(`/projects/${project.body.id}/tokens/new`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<html');
      expect(hasTag(html, 'global-header')).toBe(true);
      expect(hasTag(html, 'token-issue-name-input')).toBe(true);
    });

    it('editor → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const editor = await createUserAndLogin(ctx, admin, { email: 'editor2@example.com', password: 'editor-pass-1', displayName: 'Editor Two', role: 'editor' });
      const res = await ctx.app.request(`/projects/${project.body.id}/tokens/new`, { headers: { Cookie: cookieHeader(editor.login.jar) } });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /projects/:pid/tokens(S-17 発行)', () => {
    it('正常値 → 200 で直接ステップ2(平文1回表示)を描画。一覧には平文が出ない(Cache-Control: no-store)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const pid = project.body.id;

      const res = await ctx.app.request(`/projects/${pid}/tokens`, formReq(
        { name: 'discovery-satellite-prod', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200); // リダイレクトではなく直接描画(リロードで消える設計)
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = await res.text();

      expect(tagText(html, 'token-result-title')).toBe('トークンが発行されました');
      expect(tagText(html, 'token-result-warning')).toContain('二度と表示できません');
      const plaintext = tagText(html, 'token-result-plaintext');
      expect(plaintext).toMatch(/^tms_/);
      expect(tagText(html, 'token-result-name')).toBe('discovery-satellite-prod');
      expect(tagText(html, 'token-result-project')).toBe('payment-service');
      expect(hasTag(html, 'token-result-copy')).toBe(true);
      expect(hasTag(html, 'token-result-close')).toBe(true);

      // 一覧を再取得すると平文はどこにも無い。
      const listHtml = await (await ctx.app.request(`/projects/${pid}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } })).text();
      expect(listHtml).not.toContain(plaintext);
      expect(listHtml).toContain('discovery-satellite-prod');

      // Storage には token_hash のみで平文は保存されない実装(既存 API と同じ createApiToken 経由)。
      const stored = await ctx.storage.listApiTokens(await orgScopeOfAdmin(ctx), pid);
      expect(stored).toHaveLength(1);
    });

    it('HX-Request + 正常値 → ダイアログフラグメントのみ(ステップ2)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(`/projects/${project.body.id}/tokens`, formReq(
        { name: 'hx-issued-token', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' },
      ));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('<html');
      expect(tagText(html, 'token-result-name')).toBe('hx-issued-token');
    });

    it('name が空 → 200 + token-issue-name-error、作成されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const pid = project.body.id;
      const res = await ctx.app.request(`/projects/${pid}/tokens`, formReq(
        { name: '', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'token-issue-name-error')).toBe('トークン名を入力してください');
      expect(await ctx.storage.listApiTokens(await orgScopeOfAdmin(ctx), pid)).toHaveLength(0);
    });

    it('name が100文字超(LIMITS.name)→ 200 + エラー、作成されない(GC-1: ドキュメントの128は誤りで100が正)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const pid = project.body.id;
      const res = await ctx.app.request(`/projects/${pid}/tokens`, formReq(
        { name: 'a'.repeat(101), _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      expect(tagText(await res.text(), 'token-issue-name-error')).toBe('トークン名が長すぎます');
      expect(await ctx.storage.listApiTokens(await orgScopeOfAdmin(ctx), pid)).toHaveLength(0);
    });

    it('同名トークンを2回発行 → 両方成功する(GC-1: ドキュメントの「重複→422」は誤りで一意制約は無い)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const pid = project.body.id;
      const first = await ctx.app.request(`/projects/${pid}/tokens`, formReq({ name: 'dup-name', _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }));
      const second = await ctx.app.request(`/projects/${pid}/tokens`, formReq({ name: 'dup-name', _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await ctx.storage.listApiTokens(await orgScopeOfAdmin(ctx), pid)).toHaveLength(2);
    });

    it('editor が POST → 403、作成されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const pid = project.body.id;
      const editor = await createUserAndLogin(ctx, admin, { email: 'editor3@example.com', password: 'editor-pass-1', displayName: 'Editor Three', role: 'editor' });
      const res = await ctx.app.request(`/projects/${pid}/tokens`, formReq(
        { name: 'editor-token', _csrf: editor.login.csrf ?? '' },
        { Cookie: cookieHeader(editor.login.jar) },
      ));
      expect(res.status).toBe(403);
      expect(await ctx.storage.listApiTokens(await orgScopeOfAdmin(ctx), pid)).toHaveLength(0);
    });

    it('CSRFトークン無し → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(`/projects/${project.body.id}/tokens`, formReq({ name: 'no-csrf' }, { Cookie: cookieHeader(admin.jar) }));
      expect(res.status).toBe(403);
    });
  });

  describe('GET /projects/:pid/tokens/:id/revoke-confirm(S-16 失効確認)', () => {
    it('admin → 確認メッセージにトークン名を含む + キャンセル/実行ボタン', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const pid = project.body.id;
      await issueToken(ctx.app, admin, pid, 'discovery-ci');
      const items = (await (await ctx.app.request(`/api/v1/projects/${pid}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } })).json<any>()).items;
      const tokenId = items[0].id;

      const res = await ctx.app.request(`/projects/${pid}/tokens/${tokenId}/revoke-confirm`, {
        headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'token-revoke-confirm-message')).toContain('discovery-ci');
      expect(tagText(html, 'token-revoke-confirm-message')).toContain('失効させますか');
      expect(hasTag(html, 'token-revoke-confirm-cancel')).toBe(true);
      expect(hasTag(html, 'token-revoke-confirm-execute')).toBe(true);
    });

    it('存在しないトークンID → 一覧へ穏当にフォールバック(改ざん・直リンク)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(`/projects/${project.body.id}/tokens/does-not-exist/revoke-confirm`, {
        headers: { Cookie: cookieHeader(admin.jar) }, redirect: 'manual',
      });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`/projects/${project.body.id}/tokens`);
    });
  });

  describe('POST /projects/:pid/tokens/:id/revoke(失効実行・冪等)', () => {
    it('正常系 → 303 + flash、バッジが失効済みに切り替わる + トースト文言にトークン名', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const pid = project.body.id;
      await issueToken(ctx.app, admin, pid, 'discovery-ci');
      const items = (await (await ctx.app.request(`/api/v1/projects/${pid}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } })).json<any>()).items;
      const tokenId = items[0].id;

      const res = await ctx.app.request(`/projects/${pid}/tokens/${tokenId}/revoke`, formReq(
        { _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(303);
      const location = res.headers.get('location') ?? '';
      expect(location.startsWith(`/projects/${pid}/tokens?`)).toBe(true);

      const followRes = await ctx.app.request(location, { headers: { Cookie: cookieHeader(admin.jar) } });
      const followHtml = await followRes.text();
      expect(tagText(followHtml, 'toast')).toBe('トークン「discovery-ci」を失効しました');
      expect(tagText(followHtml, `token-status-${tokenId}`)).toContain('失効済み');
      expect(hasTag(followHtml, `token-revoke-button-${tokenId}`)).toBe(false);
    });

    it('2回失効させても冪等(2回目もエラーにならず、最初の revoked_at のまま変わらない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const pid = project.body.id;
      const scope = await orgScopeOfAdmin(ctx);
      await issueToken(ctx.app, admin, pid, 'discovery-ci');
      const items = (await (await ctx.app.request(`/api/v1/projects/${pid}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } })).json<any>()).items;
      const tokenId = items[0].id;

      const first = await ctx.app.request(`/projects/${pid}/tokens/${tokenId}/revoke`, formReq({ _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }));
      expect(first.status).toBe(303);
      const afterFirst = (await ctx.storage.listApiTokens(scope, pid)).find((t) => t.id === tokenId)!;
      expect(afterFirst.revokedAt).not.toBeNull();

      ctx.advance(1000); // 2回目は別の時刻に実行するが、revoked_at は最初の値のまま(冪等)であるはず。
      const second = await ctx.app.request(`/projects/${pid}/tokens/${tokenId}/revoke`, formReq({ _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }));
      expect(second.status).toBe(303); // 冪等: 2回目もエラーにならない

      const afterSecond = (await ctx.storage.listApiTokens(scope, pid)).find((t) => t.id === tokenId)!;
      expect(afterSecond.revokedAt).toBe(afterFirst.revokedAt);
    });

    it('editor が POST → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const pid = project.body.id;
      await issueToken(ctx.app, admin, pid, 'discovery-ci');
      const items = (await (await ctx.app.request(`/api/v1/projects/${pid}/tokens`, { headers: { Cookie: cookieHeader(admin.jar) } })).json<any>()).items;
      const editor = await createUserAndLogin(ctx, admin, { email: 'editor4@example.com', password: 'editor-pass-1', displayName: 'Editor Four', role: 'editor' });

      const res = await ctx.app.request(`/projects/${pid}/tokens/${items[0].id}/revoke`, formReq(
        { _csrf: editor.login.csrf ?? '' }, { Cookie: cookieHeader(editor.login.jar) },
      ));
      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // S-18/S-19: ユーザー管理
  // ============================================================
  describe('GET /admin/users(S-18 一覧)', () => {
    it('admin + editor + viewer(last_login_at 有無混在)→ 全列 + ロールバッジ + 自分の行インジケータ(GC-8)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const editor = await createUserAndLogin(ctx, admin, { email: 'sato@example.com', password: 'editor-pass-1', displayName: '佐藤花子', role: 'editor' });
      await createUserApi(ctx, admin, { email: 'suzuki@example.com', password: 'viewer-pass-1', displayName: '鈴木一郎', role: 'viewer' }); // 未ログインのまま

      const res = await ctx.app.request('/admin/users', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(tagText(html, 'user-list-title')).toBe('ユーザー管理');
      expect(hasTag(html, 'user-table')).toBe(true);
      expect(hasTag(html, 'user-add-button')).toBe(true);

      const adminId = admin.user.id;
      const editorId = editor.body.id;
      const viewerRes = await ctx.app.request('/api/v1/users', { headers: { Cookie: cookieHeader(admin.jar) } });
      const viewerId = (await viewerRes.json<any>()).items.find((u: any) => u.email === 'suzuki@example.com').id;

      expect(hasTag(html, `user-row-${adminId}`)).toBe(true);
      expect(tagText(html, `user-display-name-${adminId}`)).toBe(DEFAULT_SETUP_BODY.admin_display_name);
      expect(tagText(html, `user-email-${adminId}`)).toBe(DEFAULT_SETUP_BODY.admin_email);
      expect(tagText(html, `user-role-${adminId}`)).toContain('管理者');
      expect(hasTag(html, 'user-row-current')).toBe(true); // 自分(admin)の行にのみ出現

      expect(tagText(html, `user-display-name-${editorId}`)).toBe('佐藤花子');
      expect(tagText(html, `user-role-${editorId}`)).toContain('編集者');
      expect(tagText(html, `user-last-login-${editorId}`)).not.toBe('—'); // ログイン済み

      expect(tagText(html, `user-display-name-${viewerId}`)).toBe('鈴木一郎');
      expect(tagText(html, `user-role-${viewerId}`)).toContain('閲覧者');
      expect(tagText(html, `user-last-login-${viewerId}`)).toBe('—'); // 未ログイン(D-05)
    });

    it('editor → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const editor = await createUserAndLogin(ctx, admin, { email: 'editor5@example.com', password: 'editor-pass-1', displayName: 'Editor Five', role: 'editor' });
      const res = await ctx.app.request('/admin/users', { headers: { Cookie: cookieHeader(editor.login.jar) } });
      expect(res.status).toBe(403);
    });

    it('viewer → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const viewer = await createUserAndLogin(ctx, admin, { email: 'viewer5@example.com', password: 'viewer-pass-1', displayName: 'Viewer Five', role: 'viewer' });
      const res = await ctx.app.request('/admin/users', { headers: { Cookie: cookieHeader(viewer.login.jar) } });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /admin/users/new(S-19 作成ダイアログ)', () => {
    it('admin + HX-Request → 全 testid + ロール既定値 editor(GC-8)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/admin/users/new', { headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('<html');

      expect(tagText(html, 'user-dialog-title')).toBe('ユーザー追加');
      for (const testid of [
        'user-email-input', 'user-display-name-input', 'user-role-select', 'user-password-input',
        'user-dialog-cancel', 'user-dialog-submit-create',
      ]) {
        expect(hasTag(html, testid)).toBe(true);
      }
      expect(findTag(html, 'user-dialog-submit-create')).not.toMatch(/\bdisabled\b/);
      // ロール既定値は editor(S-19「ロール選択肢のデフォルト」)。
      const roleSelect = tagText(html, 'user-role-select');
      expect(roleSelect).toMatch(/<option value="editor" selected[^>]*>/);
    });

    it('非HX → S-18 一覧 + ダイアログのフルページ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/admin/users/new', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<html');
      expect(hasTag(html, 'user-table')).toBe(true);
      expect(hasTag(html, 'user-email-input')).toBe(true);
    });

    it('viewer/editor → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const editor = await createUserAndLogin(ctx, admin, { email: 'editor6@example.com', password: 'editor-pass-1', displayName: 'Editor Six', role: 'editor' });
      const res = await ctx.app.request('/admin/users/new', { headers: { Cookie: cookieHeader(editor.login.jar) } });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /admin/users/new(S-19 作成実行)', () => {
    it('正常値 → 303 + flash(display_name 込み)、一覧に反映され新規ユーザーでログインできる', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/admin/users/new', formReq(
        { email: 'sato@example.com', display_name: '佐藤花子', role: 'editor', password: 'sato-pass-1', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(303);
      const location = res.headers.get('location') ?? '';
      expect(location.startsWith('/admin/users?')).toBe(true);
      const followHtml = await (await ctx.app.request(location, { headers: { Cookie: cookieHeader(admin.jar) } })).text();
      expect(tagText(followHtml, 'toast')).toBe('ユーザー「佐藤花子」を追加しました');

      const loginRes = await loginAs(ctx.app, 'sato@example.com', 'sato-pass-1');
      expect(loginRes.res.status).toBe(200);

      // 新規作成直後は未ログインだったので last_login_at は「—」(ブリーフ Step1 の必須シナリオ)。
      // ここでは作成直後(まだログイン前)の一覧を見るため、別ユーザーを作って確認する。
      const created2 = await ctx.app.request('/admin/users/new', formReq(
        { email: 'suzuki@example.com', display_name: '鈴木二郎', role: 'viewer', password: 'suzuki-pass-1', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(created2.status).toBe(303);
      const listHtml = await (await ctx.app.request('/admin/users', { headers: { Cookie: cookieHeader(admin.jar) } })).text();
      const items = (await (await ctx.app.request('/api/v1/users', { headers: { Cookie: cookieHeader(admin.jar) } })).json<any>()).items;
      const suzukiId = items.find((u: any) => u.email === 'suzuki@example.com').id;
      expect(tagText(listHtml, `user-last-login-${suzukiId}`)).toBe('—');
    });

    it('メール重複 → 200 + インラインエラー(user-email-error)、作成されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/admin/users/new', formReq(
        { email: DEFAULT_SETUP_BODY.admin_email, display_name: 'Dup', role: 'editor', password: 'dup-pass-1', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'user-email-error')).toBe('このメールアドレスは既に使用されています');
      const items = (await (await ctx.app.request('/api/v1/users', { headers: { Cookie: cookieHeader(admin.jar) } })).json<any>()).items;
      expect(items).toHaveLength(1); // admin のみ
    });

    it('パスワードが7文字(ポリシー未満)→ 200 + インラインエラー', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/admin/users/new', formReq(
        { email: 'weak@example.com', display_name: 'Weak', role: 'editor', password: 'short12', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      expect(tagText(await res.text(), 'user-password-error')).toContain('8文字以上');
    });

    it('パスワードが129文字(上限128超・D-06)→ 200 + インラインエラー、作成されない(B6)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/admin/users/new', formReq(
        { email: 'toolong@example.com', display_name: 'TooLong', role: 'editor', password: 'a'.repeat(129), _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      expect(hasTag(await res.text(), 'user-password-error')).toBe(true);

      // 識別: 作成されていない(そのメールでログインできない)
      const attempted = await loginAs(ctx.app, 'toolong@example.com', 'a'.repeat(129));
      expect(attempted.res.status).not.toBe(200);
    });

    it('表示名が空 → 200 + インラインエラー、作成されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/admin/users/new', formReq(
        { email: 'noname@example.com', display_name: '', role: 'editor', password: 'noname-pass-1', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(hasTag(html, 'user-display-name-error')).toBe(true);
      expect(tagText(html, 'user-display-name-error')).not.toBe('');
    });

    it('editor が POST → 403、作成されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const editor = await createUserAndLogin(ctx, admin, { email: 'editor7@example.com', password: 'editor-pass-1', displayName: 'Editor Seven', role: 'editor' });
      const res = await ctx.app.request('/admin/users/new', formReq(
        { email: 'blocked@example.com', display_name: 'Blocked', role: 'editor', password: 'blocked-pass-1', _csrf: editor.login.csrf ?? '' },
        { Cookie: cookieHeader(editor.login.jar) },
      ));
      expect(res.status).toBe(403);
    });
  });

  describe('GET /admin/users/:id/edit(S-19 編集ダイアログ)', () => {
    it('他ユーザーの編集 → プリフィル済み、ロール選択は有効', async () => {
      const admin = await setupAndLogin(ctx.app);
      const editor = await createUserAndLogin(ctx, admin, { email: 'sato2@example.com', password: 'editor-pass-1', displayName: '佐藤花子', role: 'editor' });
      const res = await ctx.app.request(`/admin/users/${editor.body.id}/edit`, { headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' } });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(tagText(html, 'user-dialog-title')).toBe(`ユーザー編集: 佐藤花子`);
      expect(hasTag(html, 'user-email-readonly')).toBe(true);
      expect(tagText(html, 'user-email-readonly')).toBe('sato2@example.com');
      expect(attrValue(findTag(html, 'user-display-name-input'), 'value')).toBe('佐藤花子');
      expect(findTag(html, 'user-role-select')).not.toMatch(/\bdisabled\b/);
      expect(hasTag(html, 'user-password-reset-button')).toBe(true);
      expect(hasTag(html, 'user-disable-button')).toBe(true);
      expect(findTag(html, 'user-disable-button')).toMatch(/\bdisabled\b/); // [※未実装]
      expect(hasTag(html, 'user-dialog-submit-edit')).toBe(true);
    });

    it('自分自身の編集 → ロール選択が disabled + ツールチップ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(`/admin/users/${admin.user.id}/edit`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();
      const selectTag = findTag(html, 'user-role-select');
      expect(selectTag).toMatch(/\bdisabled\b/);
      expect(selectTag).toContain('自身のロールは変更できません');
    });

    it('存在しない id → 404', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/admin/users/does-not-exist/edit', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(404);
    });

    it('viewer/editor → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const viewer = await createUserAndLogin(ctx, admin, { email: 'viewer6@example.com', password: 'viewer-pass-1', displayName: 'Viewer Six', role: 'viewer' });
      const res = await ctx.app.request(`/admin/users/${admin.user.id}/edit`, { headers: { Cookie: cookieHeader(viewer.login.jar) } });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /admin/users/:id/edit(S-19 保存)', () => {
    it('display_name のみ変更 → 303 + flash、対象セッションは無効化されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const target = await createUserAndLogin(ctx, admin, { email: 'sato3@example.com', password: 'editor-pass-1', displayName: '佐藤花子', role: 'editor' });

      const res = await ctx.app.request(`/admin/users/${target.body.id}/edit`, formReq(
        { display_name: '佐藤花子（リーダー）', role: 'editor', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(303);

      // 対象の旧セッションは維持される(role 未変更のため無効化されない)。
      const probe = await ctx.app.request('/profile', { headers: { Cookie: cookieHeader(target.login.jar) }, redirect: 'manual' });
      expect(probe.status).toBe(200);

      const listHtml = await (await ctx.app.request('/admin/users', { headers: { Cookie: cookieHeader(admin.jar) } })).text();
      expect(listHtml).toContain('佐藤花子（リーダー）');
    });

    it('ロール変更(admin2人・自分以外を降格)→ 303 + flash(display_name+role) + 対象の旧セッション無効化', async () => {
      const admin = await setupAndLogin(ctx.app);
      const secondAdmin = await createUserAndLogin(ctx, admin, { email: 'admin2@example.com', password: 'admin2-pass-1', displayName: '次郎', role: 'admin' });

      const res = await ctx.app.request(`/admin/users/${secondAdmin.body.id}/edit`, formReq(
        { display_name: '次郎', role: 'editor', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(303);
      const location = res.headers.get('location') ?? '';
      const followHtml = await (await ctx.app.request(location, { headers: { Cookie: cookieHeader(admin.jar) } })).text();
      // S-19 の「{role}」プレースホルダはドキュメントに例文が無く解釈の余地がある。本実装は
      // 他のトースト文言(bulk 操作の日本語 ACTION_LABEL 採用)との一貫性を優先し、ROLE_LABEL
      // (日本語ラベル)を採用する(タスク報告の GC-1 突合に解釈上の判断として明記)。
      expect(tagText(followHtml, 'toast')).toBe('次郎 のロールを 編集者 に変更しました');

      // 対象(secondAdmin)の旧セッションは無効化される。
      const probe = await ctx.app.request('/profile', { headers: { Cookie: cookieHeader(secondAdmin.login.jar) }, redirect: 'manual' });
      expect(probe.status).toBe(302);
      expect(probe.headers.get('location')).toBe('/login?flash=session_expired');
    });

    it('最後の admin(自分)を降格しようとする改ざんPOST → ブロックされエラートースト、role は変わらず自セッション維持(ブリーフ Step1 必須シナリオ)', async () => {
      const admin = await setupAndLogin(ctx.app);

      const res = await ctx.app.request(`/admin/users/${admin.user.id}/edit`, formReq(
        { display_name: DEFAULT_SETUP_BODY.admin_display_name, role: 'editor', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(303);
      const location = res.headers.get('location') ?? '';
      const followHtml = await (await ctx.app.request(location, { headers: { Cookie: cookieHeader(admin.jar) } })).text();
      expect(tagText(followHtml, 'toast')).toContain('最後の管理者');
      expect(findTag(followHtml, 'toast')).toContain('toast-error');

      const stored = await ctx.storage.getUserById(admin.user.id);
      expect(stored?.role).toBe('admin'); // 変更されていない

      // 拒否されただけなので自セッションは維持される。
      const probe = await ctx.app.request('/profile', { headers: { Cookie: cookieHeader(admin.jar) }, redirect: 'manual' });
      expect(probe.status).toBe(200);
    });

    it('editor が POST → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const target = await createUserAndLogin(ctx, admin, { email: 'target1@example.com', password: 'editor-pass-1', displayName: 'Target One', role: 'editor' });
      const editor = await createUserAndLogin(ctx, admin, { email: 'editor8@example.com', password: 'editor-pass-1', displayName: 'Editor Eight', role: 'editor' });
      const res = await ctx.app.request(`/admin/users/${target.body.id}/edit`, formReq(
        { display_name: 'Hacked', role: 'editor', _csrf: editor.login.csrf ?? '' },
        { Cookie: cookieHeader(editor.login.jar) },
      ));
      expect(res.status).toBe(403);
    });
  });

  describe('POST /admin/users/:id/reset-password(S-19 パスワードリセット)', () => {
    it('正常系 → 303 + flash(display_name込み)、対象は旧PW不可・新PW可、対象セッション無効化', async () => {
      const admin = await setupAndLogin(ctx.app);
      const target = await createUserAndLogin(ctx, admin, { email: 'sato4@example.com', password: 'old-pass-1', displayName: '佐藤花子', role: 'editor' });

      const res = await ctx.app.request(`/admin/users/${target.body.id}/reset-password`, formReq(
        { new_password: 'new-pass-1', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(303);
      const location = res.headers.get('location') ?? '';
      expect(location.startsWith(`/admin/users/${target.body.id}/edit?`)).toBe(true);
      const followHtml = await (await ctx.app.request(location, { headers: { Cookie: cookieHeader(admin.jar) } })).text();
      expect(tagText(followHtml, 'toast')).toBe('佐藤花子 のパスワードをリセットしました');

      const oldLogin = await loginAs(ctx.app, 'sato4@example.com', 'old-pass-1');
      expect(oldLogin.res.status).toBe(401);
      const newLogin = await loginAs(ctx.app, 'sato4@example.com', 'new-pass-1');
      expect(newLogin.res.status).toBe(200);

      const probe = await ctx.app.request('/profile', { headers: { Cookie: cookieHeader(target.login.jar) }, redirect: 'manual' });
      expect(probe.status).toBe(302); // 旧セッション無効化
    });

    it('新パスワードが短すぎる → 200 + 編集ダイアログ再描画 + インラインエラー、リセットされない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const target = await createUserAndLogin(ctx, admin, { email: 'sato5@example.com', password: 'old-pass-1', displayName: '佐藤花子', role: 'editor' });

      const res = await ctx.app.request(`/admin/users/${target.body.id}/reset-password`, formReq(
        { new_password: 'short1', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      expect(hasTag(await res.text(), 'user-reset-password-input')).toBe(true);

      const oldLogin = await loginAs(ctx.app, 'sato5@example.com', 'old-pass-1');
      expect(oldLogin.res.status).toBe(200); // 変更されていない
    });

    it('新パスワードが129文字(上限128超・D-06)→ 200 + 再描画、リセットされない(B6)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const target = await createUserAndLogin(ctx, admin, { email: 'sato6@example.com', password: 'old-pass-1', displayName: '佐藤六実', role: 'editor' });

      const res = await ctx.app.request(`/admin/users/${target.body.id}/reset-password`, formReq(
        { new_password: 'a'.repeat(129), _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      expect(hasTag(await res.text(), 'user-reset-password-input')).toBe(true);

      // 識別: リセットされていない(旧パスワード可・新パスワード不可)
      const oldLogin = await loginAs(ctx.app, 'sato6@example.com', 'old-pass-1');
      expect(oldLogin.res.status).toBe(200);
      const newLogin = await loginAs(ctx.app, 'sato6@example.com', 'a'.repeat(129));
      expect(newLogin.res.status).not.toBe(200);
    });

    it('editor が POST → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const target = await createUserAndLogin(ctx, admin, { email: 'target2@example.com', password: 'old-pass-1', displayName: 'Target Two', role: 'editor' });
      const editor = await createUserAndLogin(ctx, admin, { email: 'editor9@example.com', password: 'editor-pass-1', displayName: 'Editor Nine', role: 'editor' });
      const res = await ctx.app.request(`/admin/users/${target.body.id}/reset-password`, formReq(
        { new_password: 'new-pass-1', _csrf: editor.login.csrf ?? '' },
        { Cookie: cookieHeader(editor.login.jar) },
      ));
      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // S-20: プロフィール・パスワード変更
  // ============================================================
  describe('GET /profile(S-20)', () => {
    it('admin/editor/viewer いずれもアクセス可 → 自分の表示名/メール/ロールを表示', async () => {
      const admin = await setupAndLogin(ctx.app);
      const viewer = await createUserAndLogin(ctx, admin, { email: 'viewer7@example.com', password: 'viewer-pass-1', displayName: 'Viewer Seven', role: 'viewer' });

      const adminRes = await ctx.app.request('/profile', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(adminRes.status).toBe(200);
      const adminHtml = await adminRes.text();
      expect(tagText(adminHtml, 'profile-title')).toBe('プロフィール');
      expect(tagText(adminHtml, 'profile-display-name')).toBe(DEFAULT_SETUP_BODY.admin_display_name);
      expect(tagText(adminHtml, 'profile-email')).toBe(DEFAULT_SETUP_BODY.admin_email);
      expect(tagText(adminHtml, 'profile-role')).toContain('管理者');
      expect(hasTag(adminHtml, 'password-current-input')).toBe(true);
      expect(hasTag(adminHtml, 'password-new-input')).toBe(true);
      expect(hasTag(adminHtml, 'password-confirm-input')).toBe(true);
      expect(hasTag(adminHtml, 'password-policy-length')).toBe(true);

      const viewerRes = await ctx.app.request('/profile', { headers: { Cookie: cookieHeader(viewer.login.jar) } });
      expect(viewerRes.status).toBe(200);
      expect(tagText(await viewerRes.text(), 'profile-role')).toContain('閲覧者');
    });

    it('セッション無し → /login?flash=session_expired へ302', async () => {
      const res = await ctx.app.request('/profile', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?flash=session_expired');
    });
  });

  describe('POST /profile(S-20 パスワード変更)', () => {
    it('正常系 → 303 + 専用flash、旧PW不可・新PW可、現在のセッションは維持、別セッションは無効化', async () => {
      const admin = await setupAndLogin(ctx.app);
      const secondSession = await loginAs(ctx.app, DEFAULT_SETUP_BODY.admin_email, DEFAULT_SETUP_BODY.admin_password);
      expect(secondSession.res.status).toBe(200);

      const res = await ctx.app.request('/profile', formReq(
        { current_password: DEFAULT_SETUP_BODY.admin_password, new_password: 'brand-new-pass-1', password_confirm: 'brand-new-pass-1', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/profile?flash=profile_password_changed');
      const followHtml = await (await ctx.app.request(res.headers.get('location')!, { headers: { Cookie: cookieHeader(admin.jar) } })).text();
      expect(tagText(followHtml, 'toast')).toBe('パスワードを変更しました。他の端末では再ログインが必要です');

      const oldLogin = await loginAs(ctx.app, DEFAULT_SETUP_BODY.admin_email, DEFAULT_SETUP_BODY.admin_password);
      expect(oldLogin.res.status).toBe(401);
      const newLogin = await loginAs(ctx.app, DEFAULT_SETUP_BODY.admin_email, 'brand-new-pass-1');
      expect(newLogin.res.status).toBe(200);

      // 現在のセッション(admin.jar)は維持される。
      const currentProbe = await ctx.app.request('/profile', { headers: { Cookie: cookieHeader(admin.jar) }, redirect: 'manual' });
      expect(currentProbe.status).toBe(200);
      // 別セッション(secondSession)は無効化される。
      const otherProbe = await ctx.app.request('/profile', { headers: { Cookie: cookieHeader(secondSession.jar) }, redirect: 'manual' });
      expect(otherProbe.status).toBe(302);
    });

    it('現在のパスワードが誤り → 200 + password-current-error、変更されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/profile', formReq(
        { current_password: 'wrong-password', new_password: 'brand-new-pass-1', password_confirm: 'brand-new-pass-1', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      expect(tagText(await res.text(), 'password-current-error')).toBe('現在のパスワードが正しくありません');

      const stillOld = await loginAs(ctx.app, DEFAULT_SETUP_BODY.admin_email, DEFAULT_SETUP_BODY.admin_password);
      expect(stillOld.res.status).toBe(200);
    });

    it('新パスワードが8文字未満 → 200 + password-new-error、変更されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/profile', formReq(
        { current_password: DEFAULT_SETUP_BODY.admin_password, new_password: 'short1', password_confirm: 'short1', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      expect(tagText(await res.text(), 'password-new-error')).toBe('パスワードは8文字以上で入力してください');
    });

    it('新パスワードが129文字(上限128超・D-06)→ 200 + password-new-error、変更されない(B6)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const tooLong = 'a'.repeat(129);
      const res = await ctx.app.request('/profile', formReq(
        { current_password: DEFAULT_SETUP_BODY.admin_password, new_password: tooLong, password_confirm: tooLong, _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      expect(hasTag(await res.text(), 'password-new-error')).toBe(true);

      // 識別: 変更されていない(旧パスワードで再ログイン可)
      const oldLogin = await loginAs(ctx.app, DEFAULT_SETUP_BODY.admin_email, DEFAULT_SETUP_BODY.admin_password);
      expect(oldLogin.res.status).toBe(200);
    });

    it('confirm がサーバーに送られても新パスワードと不一致 → サーバーは confirm を見ないため成功する(ドキュメント通り: クライアント側検証のみ)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/profile', formReq(
        { current_password: DEFAULT_SETUP_BODY.admin_password, new_password: 'brand-new-pass-1', password_confirm: 'totally-different', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(303);
      const newLogin = await loginAs(ctx.app, DEFAULT_SETUP_BODY.admin_email, 'brand-new-pass-1');
      expect(newLogin.res.status).toBe(200);
    });

    it('CSRFトークン無し → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/profile', formReq(
        { current_password: DEFAULT_SETUP_BODY.admin_password, new_password: 'brand-new-pass-1', password_confirm: 'brand-new-pass-1' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(403);
    });
  });
});
