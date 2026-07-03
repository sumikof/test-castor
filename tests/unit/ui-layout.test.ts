// tests/unit/ui-layout.test.ts
// Layout(docs/screens.md「共通レイアウト」)の単体テスト。S-01/S-02(tests/integration/ui-auth.test.ts)は
// 常に user=null で Layout を描画するため、GlobalHeader/ProjectContextHeader/Breadcrumb は
// そちらのスモークテストでは一切exerciseされない。Task 18 以降(認証済みページ)が同じ Layout に
// 依存するため、ここで直接(D1/セッション不要な純粋関数として)描画結果を検証しておく。
// Layout はただの関数(JSX を返す)なので .ts から呼び出すこと自体に JSX 構文は不要。実際の文字列化は
// 本番と同じ経路(Hono の c.html())を通す。
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { Layout, type LayoutProps } from '../../src/http/ui/layout';
import type { UserRow, ProjectRow } from '../../src/storage/schema';

async function renderLayout(props: LayoutProps): Promise<{ status: number; html: string }> {
  const app = new Hono();
  app.get('/x', (c) => c.html(Layout(props)));
  const res = await app.request('/x');
  return { status: res.status, html: await res.text() };
}

const adminUser: UserRow = {
  id: 'u1', organizationId: 'o1', email: 'admin@example.com', passwordHash: null,
  displayName: 'Admin Taro', role: 'admin', lastLoginAt: null, createdAt: 0, updatedAt: 0,
};
const viewerUser: UserRow = { ...adminUser, id: 'u2', role: 'viewer', displayName: 'Viewer Ichiro' };
const project: ProjectRow = { id: 'p1', organizationId: 'o1', name: 'payment-service', repoUrl: null, createdAt: 0, updatedAt: 0 };

describe('ui/layout: Layout', () => {
  it('user 未指定なら GlobalHeader を描画しない(S-01/S-02 で使う形)', async () => {
    const { html } = await renderLayout({ title: 'T', user: null, children: 'body-content' });
    expect(html).not.toContain('data-testid="global-header"');
    expect(html).toContain('body-content');
  });

  it('GlobalHeader: user 指定時は「プロジェクト」navを描画し、「ダッシュボード」は出さない(D-13-1: S-05はMVP後)', async () => {
    const { html } = await renderLayout({ title: 'T', user: viewerUser, csrf: 'tok', children: 'body' });
    expect(html).toContain('data-testid="global-header"');
    expect(html).toContain('data-testid="nav-projects"');
    expect(html).not.toContain('ダッシュボード');
    expect(html).not.toContain('data-testid="nav-admin-users"'); // viewer には出さない
  });

  it('GlobalHeader: admin ロールには「ユーザー管理」リンクを描画する', async () => {
    const { html } = await renderLayout({ title: 'T', user: adminUser, csrf: 'tok', children: 'body' });
    expect(html).toContain('data-testid="nav-admin-users"');
  });

  it('GlobalHeader: ユーザーメニューにプロフィール/ログアウト、ログアウトフォームに csrf hidden を埋め込む', async () => {
    const { html } = await renderLayout({ title: 'T', user: adminUser, csrf: 'tok-abc', children: 'body' });
    expect(html).toContain('data-testid="user-menu-profile"');
    expect(html).toContain('data-testid="user-menu-logout"');
    expect(html).toMatch(/name="_csrf" value="tok-abc"/);
  });

  it('ProjectContextHeader: project+user 指定時のみ描画し、admin にはトークン/設定リンクも出す', async () => {
    const { html } = await renderLayout({ title: 'T', user: adminUser, project, children: 'body' });
    expect(html).toContain('data-testid="project-context-header"');
    expect(html).toContain('payment-service');
    expect(html).toContain('data-testid="nav-tokens"');
    expect(html).toContain('data-testid="nav-settings"');
  });

  it('ProjectContextHeader: viewer にはトークン/設定リンクを出さない', async () => {
    const { html } = await renderLayout({ title: 'T', user: viewerUser, project, children: 'body' });
    expect(html).toContain('data-testid="project-context-header"');
    expect(html).not.toContain('data-testid="nav-tokens"');
    expect(html).not.toContain('data-testid="nav-settings"');
  });

  it('project 未指定なら ProjectContextHeader を描画しない', async () => {
    const { html } = await renderLayout({ title: 'T', user: adminUser, children: 'body' });
    expect(html).not.toContain('data-testid="project-context-header"');
  });

  it('Breadcrumb: 複数階層をラベル+インデックス付き testid で描画する', async () => {
    const { html } = await renderLayout({
      title: 'T',
      user: adminUser,
      breadcrumb: [{ label: 'プロジェクト', href: '/projects' }, { label: 'payment-service' }],
      children: 'body',
    });
    expect(html).toContain('data-testid="breadcrumb"');
    expect(html).toContain('data-testid="breadcrumb-item-0"');
    expect(html).toContain('data-testid="breadcrumb-item-1"');
  });

  it('flash: kind別のtoastクラスと文言を描画する(screens.md「共通レイアウト > 通知・トースト」)', async () => {
    const { html } = await renderLayout({ title: 'T', user: null, flash: { kind: 'success', text: 'メッセージA' }, children: 'body' });
    expect(html).toContain('data-testid="toast"');
    expect(html).toContain('toast-success');
    expect(html).toContain('メッセージA');
  });

  it('flash 未指定ならトーストを描画しない', async () => {
    const { html } = await renderLayout({ title: 'T', user: null, children: 'body' });
    expect(html).not.toContain('data-testid="toast"');
  });

  it('資産配線: app.css / htmx.min.js を head に含む', async () => {
    const { html } = await renderLayout({ title: 'T', user: null, children: 'body' });
    expect(html).toContain('<link rel="stylesheet" href="/app.css"');
    expect(html).toContain('src="/htmx.min.js"');
  });

  it('csrf 指定時は body の hx-headers に X-CSRF-Token を埋め込む(D-09)', async () => {
    const { html } = await renderLayout({ title: 'T', user: null, csrf: 'abc123', children: 'body' });
    expect(html).toContain('X-CSRF-Token');
    expect(html).toContain('abc123');
  });

  it('csrf 未指定なら hx-headers 属性を出さない', async () => {
    const { html } = await renderLayout({ title: 'T', user: null, children: 'body' });
    expect(html).not.toContain('hx-headers');
  });
});
