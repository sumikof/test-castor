// tests/integration/ui-projects.test.ts
// task-18-brief.md「プロジェクト画面(S-06 一覧 / S-07 作成ダイアログ)」SSR スモークテスト。
// docs/screens/main/S-06-project-list.md・S-07-project-create-dialog.md と1:1で対応させる(GC-1)。
// tests/integration/ui-auth.test.ts と同じハーネス(実 D1 + 固定クロック + 低イテレーション Auth)を使う。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  makeTestApp, wipe, cookieHeader, setupAndLogin, loginAs, createProject, DEFAULT_SETUP_BODY, type TestApp,
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
 * ネストした同名タグを含む要素(dialog-overlay 等)には使わない(project-create-dialog 等の内部に
 * 別の <div> があるとマッチが早期終了するため。本ファイルでは非ネスト要素にのみ使用する)。 */
function tagText(html: string, testid: string): string {
  const openMatch = html.match(new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)[^>]*data-testid="${testid}"[^>]*>`));
  if (!openMatch) throw new Error(`data-testid="${testid}" を持つタグが見つからない`);
  const tagName = openMatch[1];
  const startIdx = (openMatch.index ?? 0) + openMatch[0].length;
  const endIdx = html.indexOf(`</${tagName}>`, startIdx);
  if (endIdx === -1) throw new Error(`data-testid="${testid}" の終了タグ </${tagName}> が見つからない`);
  return html.slice(startIdx, endIdx);
}

/** POST /api/v1/users でロール指定のユーザーを作り、ログインする(ui-auth.test.ts の
 * createViewerAndLogin を editor にも使えるよう一般化)。 */
async function createUserAndLogin(
  ctx: TestApp,
  adminCtx: { jar: Record<string, string>; csrf?: string },
  email: string,
  role: 'viewer' | 'editor',
) {
  const password = `${role}-pass-1`;
  const res = await ctx.app.request('/api/v1/users', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookieHeader(adminCtx.jar),
      'x-csrf-token': adminCtx.csrf ?? '',
    },
    body: JSON.stringify({ email, password, display_name: `${role} One`, role }),
  });
  if (res.status !== 201) throw new Error(`${role}作成に失敗: ${res.status} ${await res.text()}`);
  return loginAs(ctx.app, email, password);
}

/** 管理者セッションの組織スコープでの storage.listProjects(D-05: testcaseCount 込み)。 */
async function listProjectsAsAdmin(ctx: TestApp) {
  const user = await ctx.storage.findUserForLogin(DEFAULT_SETUP_BODY.admin_email);
  if (!user) throw new Error('admin user not found');
  return ctx.storage.listProjects({ organizationId: user.organizationId });
}

describe('SSR: プロジェクト画面(S-06/S-07)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec);
  });

  describe('GET /projects(S-06 一覧・空状態)', () => {
    it('admin・プロジェクト0件 → 空状態メッセージ + 新規作成ボタン(ヘッダー・空状態の両方)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(tagText(html, 'page-title')).toBe('プロジェクト一覧');
      expect(hasTag(html, 'global-header')).toBe(true);
      expect(hasTag(html, 'project-create-button')).toBe(true);
      expect(tagText(html, 'project-empty-state')).toContain('プロジェクトがありません');
      expect(hasTag(html, 'project-empty-create')).toBe(true);
      expect(hasTag(html, 'project-table')).toBe(false);
    });

    it('viewer・プロジェクト0件 → 空状態メッセージのみ(作成ボタンは無し)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const viewer = await createUserAndLogin(ctx, admin, 'viewer@example.com', 'viewer');
      const res = await ctx.app.request('/projects', { headers: { Cookie: cookieHeader(viewer.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(hasTag(html, 'project-empty-state')).toBe(true);
      expect(hasTag(html, 'project-create-button')).toBe(false);
      expect(hasTag(html, 'project-empty-create')).toBe(false);
    });

    it('editor・プロジェクトあり → テーブル表示のみ(作成ボタンは無し)', async () => {
      const admin = await setupAndLogin(ctx.app);
      await createProject(ctx.app, admin, 'editor-visible-project');
      const editor = await createUserAndLogin(ctx, admin, 'editor@example.com', 'editor');
      const res = await ctx.app.request('/projects', { headers: { Cookie: cookieHeader(editor.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(hasTag(html, 'project-table')).toBe(true);
      expect(hasTag(html, 'project-create-button')).toBe(false);
    });

    it('プロジェクトがある場合 → テーブルに名前・repo_url・testcase_count(GC-8 の全 testid)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(
        ctx.app, admin, 'payment-service', 'https://github.com/example/payment',
      );
      const res = await ctx.app.request('/projects', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(hasTag(html, 'project-table')).toBe(true);
      expect(hasTag(html, 'project-empty-state')).toBe(false);
      for (const testid of ['project-table-header-name', 'project-table-header-repo', 'project-table-header-count']) {
        expect(hasTag(html, testid)).toBe(true);
      }
      expect(hasTag(html, `project-row-${project.id}`)).toBe(true);
      expect(tagText(html, `project-name-${project.id}`)).toBe('payment-service');
      expect(attrValue(findTag(html, `project-name-${project.id}`), 'href')).toBe(`/projects/${project.id}/testcases`);
      expect(tagText(html, `project-repo-${project.id}`)).toBe('https://github.com/example/payment');
      expect(tagText(html, `project-testcase-count-${project.id}`)).toBe('0');
    });

    it('repo_url が null のプロジェクト → 「—」表示(リンクにならない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'no-repo-service');
      const res = await ctx.app.request('/projects', { headers: { Cookie: cookieHeader(admin.jar) } });
      const html = await res.text();

      expect(tagText(html, `project-repo-${project.id}`)).toBe('—');
      expect(findTag(html, `project-repo-${project.id}`)).not.toMatch(/^<a /);
    });

    it('testcase_count は非archivedテストケース件数を反映する(D-05)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'svc-with-tc');
      for (let i = 0; i < 2; i += 1) {
        const tcRes = await ctx.app.request(`/api/v1/projects/${project.id}/testcases`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Cookie: cookieHeader(admin.jar),
            'x-csrf-token': admin.csrf ?? '',
          },
          body: JSON.stringify({ title: `tc-${i}`, category: 'normal', given: 'g', when: 'w', then: 't' }),
        });
        expect(tcRes.status).toBe(201);
      }
      const res = await ctx.app.request('/projects', { headers: { Cookie: cookieHeader(admin.jar) } });
      const html = await res.text();
      expect(tagText(html, `project-testcase-count-${project.id}`)).toBe('2');
    });

    it('?flash=project_created → toast に成功文言(S-06のトースト)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects?flash=project_created', { headers: { Cookie: cookieHeader(admin.jar) } });
      const html = await res.text();
      expect(tagText(html, 'toast')).toBe('プロジェクトを作成しました');
      expect(findTag(html, 'toast')).toContain('toast-success');
    });

    it('セッション無し → /login?flash=session_expired へ302', async () => {
      const res = await ctx.app.request('/projects', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?flash=session_expired');
    });
  });

  describe('GET /projects/new(S-07 ダイアログ)', () => {
    it('admin + HX-Request → ダイアログのフラグメントのみ(<html>/global-headerを含まない)+ 全 testid(GC-8)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects/new', {
        headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).not.toContain('<html');
      expect(html).not.toContain('global-header');

      expect(tagText(html, 'project-create-dialog-title')).toBe('プロジェクト作成');
      for (const testid of [
        'dialog-overlay', 'project-create-dialog', 'project-create-dialog-close',
        'project-name-label', 'project-name-input', 'project-name-error',
        'project-repo-label', 'project-repo-input', 'project-repo-hint', 'project-repo-error',
        'project-create-cancel', 'project-create-submit',
      ]) {
        expect(hasTag(html, testid)).toBe(true);
      }
      // フォームは _csrf hidden を必ず含む(D-09)。
      expect(html).toMatch(/<input type="hidden" name="_csrf" value="[^"]+"/);
      // no-JS プログレッシブエンハンスメント: SSR は disabled を持たない(Task 17 の修正方針を踏襲)。
      expect(findTag(html, 'project-create-submit')).not.toMatch(/\bdisabled\b/);
      // S-07キーボード操作(Escape)を実装したことの固定: フラグメント自身に閉じるスクリプトが同梱される。
      expect(html).toContain('Escape');
    });

    it('admin + 通常リクエスト(非HX) → S-06 一覧 + ダイアログを開いた状態のフルページ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects/new', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('<html');
      expect(hasTag(html, 'global-header')).toBe(true);
      expect(hasTag(html, 'page-title')).toBe(true);
      expect(hasTag(html, 'project-create-dialog')).toBe(true);
      expect(hasTag(html, 'project-name-input')).toBe(true);
    });

    it('viewer → 403(HTML ページ、ダイアログは表示されない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const viewer = await createUserAndLogin(ctx, admin, 'viewer2@example.com', 'viewer');
      const res = await ctx.app.request('/projects/new', { headers: { Cookie: cookieHeader(viewer.jar) } });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(tagText(html, 'page-403-title')).toBe('アクセスできません');
      expect(hasTag(html, 'project-create-dialog')).toBe(false);
    });

    it('editor → 403(HTML ページ)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const editor = await createUserAndLogin(ctx, admin, 'editor3@example.com', 'editor');
      const res = await ctx.app.request('/projects/new', { headers: { Cookie: cookieHeader(editor.jar) } });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /projects(S-07 フォーム送信)', () => {
    it('正常値(name+repo_url)→ 303 で /projects?flash=project_created へ、一覧に反映される', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects', formReq(
        { name: 'payment-service', repo_url: 'https://github.com/example/payment', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/projects?flash=project_created');

      const items = await listProjectsAsAdmin(ctx);
      expect(items).toHaveLength(1);
      expect(items[0]?.name).toBe('payment-service');
      expect(items[0]?.repoUrl).toBe('https://github.com/example/payment');

      const listRes = await ctx.app.request('/projects', { headers: { Cookie: cookieHeader(admin.jar) } });
      const listHtml = await listRes.text();
      expect(listHtml).toContain('payment-service');
    });

    it('repo_url を空欄のまま送信(任意項目)→ 作成でき、一覧では「—」表示になる', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects', formReq(
        { name: 'no-repo-project', repo_url: '', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(303);

      const items = await listProjectsAsAdmin(ctx);
      expect(items).toHaveLength(1);
      expect(items[0]?.repoUrl).toBeNull();
    });

    it('name が空 → 200 + project-name-error、プロジェクトは作成されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects', formReq(
        { name: '', repo_url: '', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'project-name-error')).toBe('プロジェクト名を入力してください');
      expect(await listProjectsAsAdmin(ctx)).toHaveLength(0);
    });

    it('name が100文字超 → 200 + project-name-error に「プロジェクト名が長すぎます」', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects', formReq(
        { name: 'a'.repeat(101), repo_url: '', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'project-name-error')).toBe('プロジェクト名が長すぎます');
      expect(await listProjectsAsAdmin(ctx)).toHaveLength(0);
    });

    it('repo_url が不正な形式 → 200 + project-repo-error、name は再表示され、プロジェクトは作成されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects', formReq(
        { name: 'valid-name', repo_url: 'not-a-url', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'project-repo-error')).toBe('有効な URL を入力してください');
      expect(attrValue(findTag(html, 'project-name-input'), 'value')).toBe('valid-name');
      expect(await listProjectsAsAdmin(ctx)).toHaveLength(0);
    });

    it('repo_url が ftp:// 等 http/https 以外 → 200 + project-repo-error', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects', formReq(
        { name: 'valid-name-2', repo_url: 'ftp://example.com/repo', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'project-repo-error')).toBe('有効な URL を入力してください');
      expect(await listProjectsAsAdmin(ctx)).toHaveLength(0);
    });

    it('HX-Request でのバリデーションエラー → ダイアログフラグメントのみ再描画(<html> を含まない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects', formReq(
        { name: '', repo_url: '', _csrf: admin.csrf ?? '' },
        { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' },
      ));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('<html');
      expect(tagText(html, 'project-name-error')).toBe('プロジェクト名を入力してください');
    });

    it('editor が POST → 403(HTMLページ、作成されない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const editor = await createUserAndLogin(ctx, admin, 'editor4@example.com', 'editor');
      const res = await ctx.app.request('/projects', formReq(
        { name: 'editor-project', repo_url: '', _csrf: editor.csrf ?? '' },
        { Cookie: cookieHeader(editor.jar) },
      ));
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(tagText(html, 'page-403-title')).toBe('アクセスできません');
      expect(await listProjectsAsAdmin(ctx)).toHaveLength(0);
    });

    it('viewer が POST → 403(作成されない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const viewer = await createUserAndLogin(ctx, admin, 'viewer3@example.com', 'viewer');
      const res = await ctx.app.request('/projects', formReq(
        { name: 'viewer-project', repo_url: '', _csrf: viewer.csrf ?? '' },
        { Cookie: cookieHeader(viewer.jar) },
      ));
      expect(res.status).toBe(403);
      expect(await listProjectsAsAdmin(ctx)).toHaveLength(0);
    });

    it('CSRFトークン無し → 403(作成されない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects', formReq(
        { name: 'no-csrf-project', repo_url: '' },
        { Cookie: cookieHeader(admin.jar) },
      ));
      expect(res.status).toBe(403);
      expect(await listProjectsAsAdmin(ctx)).toHaveLength(0);
    });
  });
});
