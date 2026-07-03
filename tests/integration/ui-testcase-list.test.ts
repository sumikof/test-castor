// tests/integration/ui-testcase-list.test.ts
// task-19-brief.md「テストケース一覧(S-08)+ 一括操作確認(S-15)」SSR スモークテスト。
// docs/screens/testcase/S-08-testcase-list.md(要素カタログが最大の画面。全 testid を検証)・
// S-15-bulk-operation-confirm.md・スペック D-01(sync/status)/D-03(exact total・cursor pagination・
// 前へ廃止)と1:1で対応させる(GC-1)。tests/integration/ui-projects.test.ts と同じハーネス
// (実 D1 + 固定クロック)を使う。
//
// test_cases 行は Task 13/14 の Storage(createTestCaseManual)だと ownership が常に 'human' 固定に
// なり machine 所有行を作れない(apis/testcases.md の業務ルール)ため、tests/integration/
// helpers-seed.ts と同じ「直挿しシード」方針で本ファイル専用の rawExec ベースのシードヘルパを使う
// (Task 15/16 の同期実装 start/chunk/commit に依存させず、drift/is_stale/ownership を自在に
// 組み合わせられるようにするため)。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  makeTestApp, wipe, cookieHeader, setupAndLogin, loginAs, createProject, FIXED_NOW, type TestApp,
} from './helpers';

// --- ローカルテストユーティリティ(ui-projects.test.ts と同じ規約でファイルごとに複製する) ---

function formReq(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  };
}

/** ids[] を複数値として持てる一括操作フォーム送信用(formReq は同一キー複数値を表現できないため専用化)。 */
function bulkFormReq(ids: string[], action: string, csrf: string, headers: Record<string, string> = {}) {
  const sp = new URLSearchParams();
  for (const id of ids) sp.append('ids[]', id);
  sp.set('action', action);
  sp.set('_csrf', csrf);
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: sp.toString(),
  };
}

function confirmUrl(pid: string, ids: string[], action: string): string {
  const sp = new URLSearchParams();
  for (const id of ids) sp.append('ids[]', id);
  sp.set('action', action);
  return `/projects/${pid}/testcases/bulk-confirm?${sp.toString()}`;
}

function findTag(html: string, testid: string): string {
  const re = new RegExp(`<[a-zA-Z][^>]*data-testid="${testid}"[^>]*>`);
  const m = html.match(re);
  if (!m) throw new Error(`data-testid="${testid}" を持つタグが見つからない\n---\n${html}`);
  return m[0];
}
function hasTag(html: string, testid: string): boolean {
  return new RegExp(`data-testid="${testid}"`).test(html);
}
/** JSX は属性値中の `&` 等を HTML エンティティとして正しくエスケープする(`&` → `&amp;`)。抽出した
 * href をそのまま次のリクエストの URL に使う/文字列比較する際は、実際の文字に戻す必要がある。 */
function unescapeHtml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function attrValue(tag: string, attr: string): string | null {
  const m = tag.match(new RegExp(`${attr}="([^"]*)"`));
  return m?.[1] !== undefined ? unescapeHtml(m[1]) : null;
}
function tagText(html: string, testid: string): string {
  const openMatch = html.match(new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)[^>]*data-testid="${testid}"[^>]*>`));
  if (!openMatch) throw new Error(`data-testid="${testid}" を持つタグが見つからない`);
  const tagName = openMatch[1];
  const startIdx = (openMatch.index ?? 0) + openMatch[0].length;
  const endIdx = html.indexOf(`</${tagName}>`, startIdx);
  if (endIdx === -1) throw new Error(`data-testid="${testid}" の終了タグ </${tagName}> が見つからない`);
  return html.slice(startIdx, endIdx);
}

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

// --- test_cases / sync_sessions 直挿しシード(Task 15/16 の同期実装に依存しない) ---

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

interface SeedTcParams {
  id: string;
  pid: string;
  title: string;
  target?: string | null;
  category: 'normal' | 'abnormal' | 'boundary' | 'error_handling';
  status: 'draft' | 'approved' | 'archived';
  ownership: 'machine' | 'human';
  drift?: boolean;
  isStale?: boolean;
  createdAt: number;
}

/** ck_tc_status_ownership(status='draft' OR ownership='human')を満たす組み合わせのみ渡すこと。 */
async function seedTestCase(rawExec: TestApp['rawExec'], p: SeedTcParams): Promise<void> {
  await rawExec(
    'INSERT INTO test_cases ' +
      '(id, project_id, title, target, category, given, "when", "then", parameters, status, is_stale, ownership, ' +
      'mirror_origin, drift, fingerprint, version, confidence, source_ref, created_origin, metadata, ' +
      'human_updated_at, system_updated_at, created_at) ' +
      `VALUES (${sqlStr(p.id)}, ${sqlStr(p.pid)}, ${sqlStr(p.title)}, ${p.target ? sqlStr(p.target) : 'NULL'}, ` +
      `${sqlStr(p.category)}, 'given text', 'when text', 'then text', NULL, ${sqlStr(p.status)}, ` +
      `${p.isStale ? 1 : 0}, ${sqlStr(p.ownership)}, NULL, ${p.drift ? 1 : 0}, NULL, 1, NULL, NULL, ` +
      `${sqlStr(p.ownership === 'machine' ? 'synced' : 'manual')}, NULL, NULL, NULL, ${p.createdAt})`,
  );
}

interface SeedSyncParams {
  pid: string;
  origin: string;
  committedAt: number;
  createdCount: number;
  changedCount: number;
  staledCount: number;
}

/** committed 済み sync_sessions 行を created/changed/staled_count 込みで直挿しする(syncStatus の
 * origins[].lastSummary を非ゼロ値で検証するため。helpers-seed.ts の seedCommittedObservation は
 * これらのカウント列を NULL のまま挿入するため、本ファイル専用に別途用意する)。 */
async function seedCommittedSyncSession(rawExec: TestApp['rawExec'], p: SeedSyncParams): Promise<void> {
  const token = crypto.randomUUID();
  await rawExec(
    'INSERT INTO sync_sessions ' +
      '(token, project_id, origin, status, started_at, expires_at, committed_at, created_count, changed_count, staled_count) ' +
      `VALUES (${sqlStr(token)}, ${sqlStr(p.pid)}, ${sqlStr(p.origin)}, 'committed', ${p.committedAt - 1000}, ` +
      `${p.committedAt + 600_000}, ${p.committedAt}, ${p.createdCount}, ${p.changedCount}, ${p.staledCount})`,
  );
}

/** S-08 の主要フィクスチャ: 5件のテストケース(created_at 降順で E,D,C,B,A)。
 * - A: normal / approved / human                      (基準行)
 * - B: abnormal / draft    / machine                   (新規=unreviewed 候補)
 * - C: boundary / draft    / machine / is_stale         (stale)
 * - D: error_handling / approved / human / drift        (drift。approved+human は制約上も自然)
 * - E: normal / draft / human / target が別サービス      (target 部分一致フィルタの除外確認用)
 */
async function seedFixture(ctx: TestApp, pid: string) {
  const ids = {
    a: crypto.randomUUID(), b: crypto.randomUUID(), c: crypto.randomUUID(), d: crypto.randomUUID(), e: crypto.randomUUID(),
  };
  await seedTestCase(ctx.rawExec, {
    id: ids.a, pid, title: '有効カードで決済成功', target: 'com.example.PaymentService#charge',
    category: 'normal', status: 'approved', ownership: 'human', createdAt: FIXED_NOW - 5000,
  });
  await seedTestCase(ctx.rawExec, {
    id: ids.b, pid, title: '期限切れカードでエラー', target: 'com.example.PaymentService#charge',
    category: 'abnormal', status: 'draft', ownership: 'machine', createdAt: FIXED_NOW - 4000,
  });
  await seedTestCase(ctx.rawExec, {
    id: ids.c, pid, title: '金額0円で決済', target: 'com.example.PaymentService#charge',
    category: 'boundary', status: 'draft', ownership: 'machine', isStale: true, createdAt: FIXED_NOW - 3000,
  });
  await seedTestCase(ctx.rawExec, {
    id: ids.d, pid, title: 'DB接続失敗時リトライ', target: 'com.example.PaymentService#charge',
    category: 'error_handling', status: 'approved', ownership: 'human', drift: true, createdAt: FIXED_NOW - 2000,
  });
  await seedTestCase(ctx.rawExec, {
    id: ids.e, pid, title: '別注文のケース', target: 'com.example.OrderService#pay',
    category: 'normal', status: 'draft', ownership: 'human', createdAt: FIXED_NOW - 1000,
  });
  return ids;
}

describe('SSR: テストケース一覧(S-08)+ 一括操作確認(S-15)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec);
  });

  describe('GET /projects/:pid/testcases(S-08 一覧)', () => {
    it('プロジェクト未存在 → 404 + 「プロジェクトが見つかりません」', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request('/projects/does-not-exist/testcases', { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(404);
      expect(tagText(await res.text(), 'page-404-title')).toBe('プロジェクトが見つかりません');
    });

    it('セッション無し → /login?flash=session_expired へ302', async () => {
      const res = await ctx.app.request('/projects/whatever/testcases', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/login?flash=session_expired');
    });

    it('0件(フィルタなし)→ empty-state(新規作成誘導つき)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'empty-project');
      const res = await ctx.app.request(`/projects/${project.id}/testcases`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(hasTag(html, 'empty-state')).toBe(true);
      expect(hasTag(html, 'empty-state-create')).toBe(true);
      expect(hasTag(html, 'testcase-table')).toBe(false);
      expect(tagText(html, 'testcase-count')).toBe('0');
    });

    it('フィルタ適用で0件 → empty-state-filtered(通常の空状態とは別testid)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'svc-filtered-empty');
      await seedFixture(ctx, project.id);
      // archived な行は無いフィクスチャなので該当0件になる。
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?status=archived`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const html = await res.text();
      expect(hasTag(html, 'empty-state-filtered')).toBe(true);
      expect(hasTag(html, 'empty-state')).toBe(false);
    });

    it('フィルタ無し: 全件のヘッダー・件数・全testidの土台が描画される(GC-8)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'payment-service');
      await seedFixture(ctx, project.id);

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(tagText(html, 'testcase-count')).toBe('5');
      expect(attrValue(findTag(html, 'link-back-to-project'), 'href')).toBe('/projects');
      expect(tagText(html, 'project-name')).toBe('payment-service');
      expect(hasTag(html, 'btn-create-testcase')).toBe(true);

      for (const testid of [
        'filter-form', 'filter-status', 'filter-category', 'filter-ownership', 'filter-drift', 'filter-stale',
        'filter-target', 'btn-clear-filters', 'th-title', 'th-target', 'th-category', 'th-status', 'th-updated',
        'checkbox-select-all', 'selected-count', 'btn-bulk-action',
        'bulk-action-approve', 'bulk-action-archive', 'bulk-action-restore',
        'testcase-table', 'btn-next-page',
      ]) {
        expect(hasTag(html, testid)).toBe(true);
      }
      // S-08「フリーテキスト検索」(filter-search)は MVP 除外(タスク指示)。
      expect(hasTag(html, 'filter-search')).toBe(false);
      // D-03: 前へボタンは廃止。
      expect(hasTag(html, 'btn-prev-page')).toBe(false);
      // 先頭ページ(cursor 無し)では「先頭に戻る」は不要。
      expect(hasTag(html, 'link-back-to-top')).toBe(false);
      // 一括操作メニューは選択0件が既定のため disabled。
      expect(findTag(html, 'btn-bulk-action')).toMatch(/\bdisabled\b/);
      expect(tagText(html, 'selected-count')).toBe('選択中: 0件');
    });

    it('行の内容・バッジ(status生値/category略称/ownershipアイコン/drift/stale)が正しく出し分けられる', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'badge-check-svc');
      const ids = await seedFixture(ctx, project.id);

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const html = await res.text();

      // A: normal/approved/human, drift/stale 無し
      expect(tagText(html, `cell-title-${ids.a}`)).toBe('有効カードで決済成功');
      expect(tagText(html, `cell-target-${ids.a}`)).toBe('com.example.PaymentService#charge');
      expect(tagText(html, `cell-category-${ids.a}`)).toBe('正常');
      expect(tagText(html, `cell-status-${ids.a}`)).toBe('approved');
      expect(tagText(html, `cell-ownership-${ids.a}`)).toBe('👤');
      expect(hasTag(html, `badge-drift-${ids.a}`)).toBe(false);
      expect(hasTag(html, `badge-stale-${ids.a}`)).toBe(false);

      // B: abnormal/draft/machine
      expect(tagText(html, `cell-category-${ids.b}`)).toBe('異常');
      expect(tagText(html, `cell-status-${ids.b}`)).toBe('draft');
      expect(tagText(html, `cell-ownership-${ids.b}`)).toBe('👻');

      // C: boundary/draft/machine/stale
      expect(tagText(html, `cell-category-${ids.c}`)).toBe('境界');
      expect(hasTag(html, `badge-stale-${ids.c}`)).toBe(true);
      expect(hasTag(html, `badge-drift-${ids.c}`)).toBe(false);

      // D: error_handling/approved/human/drift
      expect(tagText(html, `cell-category-${ids.d}`)).toBe('エラー');
      expect(hasTag(html, `badge-drift-${ids.d}`)).toBe(true);
      expect(hasTag(html, `badge-stale-${ids.d}`)).toBe(false);

      // 行チェックボックス(editor+)
      expect(hasTag(html, `checkbox-row-${ids.a}`)).toBe(true);
      expect(attrValue(findTag(html, `checkbox-row-${ids.a}`), 'value')).toBe(ids.a);
    });

    it('status=draft フィルタ → draft の3件のみ(E,C,B の順・created_at DESC)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'filter-status-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?status=draft&limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const html = await res.text();
      expect(tagText(html, 'testcase-count')).toBe('3');
      for (const id of [ids.e, ids.c, ids.b]) expect(hasTag(html, `testcase-row-${id}`)).toBe(true);
      for (const id of [ids.a, ids.d]) expect(hasTag(html, `testcase-row-${id}`)).toBe(false);
      // 出現順(created_at DESC): E(-1000) > C(-3000) > B(-4000)
      const order = [ids.e, ids.c, ids.b].map((id) => html.indexOf(`testcase-row-${id}`));
      expect(order[0]).toBeLessThan(order[1] as number);
      expect(order[1]).toBeLessThan(order[2] as number);
      // フォームが選択中の値を再表示する(status select に selected="draft")。
      expect(attrValue(findTag(html, 'filter-status'), 'name')).toBe('status');
    });

    it('category=normal フィルタ → A, E の2件', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'filter-category-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?category=normal&limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const html = await res.text();
      expect(tagText(html, 'testcase-count')).toBe('2');
      expect(hasTag(html, `testcase-row-${ids.a}`)).toBe(true);
      expect(hasTag(html, `testcase-row-${ids.e}`)).toBe(true);
      expect(hasTag(html, `testcase-row-${ids.b}`)).toBe(false);
    });

    it('ownership=machine フィルタ → B, C の2件', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'filter-ownership-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?ownership=machine&limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const html = await res.text();
      expect(tagText(html, 'testcase-count')).toBe('2');
      expect(hasTag(html, `testcase-row-${ids.b}`)).toBe(true);
      expect(hasTag(html, `testcase-row-${ids.c}`)).toBe(true);
      expect(hasTag(html, `testcase-row-${ids.a}`)).toBe(false);
    });

    it('drift=true フィルタ → D の1件のみ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'filter-drift-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?drift=true&limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const html = await res.text();
      expect(tagText(html, 'testcase-count')).toBe('1');
      expect(hasTag(html, `testcase-row-${ids.d}`)).toBe(true);
      expect(hasTag(html, `testcase-row-${ids.a}`)).toBe(false);
    });

    it('is_stale=true フィルタ(filter-stale)→ C の1件のみ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'filter-stale-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?is_stale=true&limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const html = await res.text();
      expect(tagText(html, 'testcase-count')).toBe('1');
      expect(hasTag(html, `testcase-row-${ids.c}`)).toBe(true);
    });

    it('target 部分一致フィルタ → PaymentService の4件(OrderService の E は除外)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'filter-target-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?target=PaymentService&limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const html = await res.text();
      expect(tagText(html, 'testcase-count')).toBe('4');
      expect(hasTag(html, `testcase-row-${ids.e}`)).toBe(false);
      for (const id of [ids.a, ids.b, ids.c, ids.d]) expect(hasTag(html, `testcase-row-${id}`)).toBe(true);
    });

    it('ページネーション: limit=2 で次へリンクに next_cursor が載る→追うと残り3件目のページに進む・先頭に戻るが現れる', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'pagination-svc');
      const ids = await seedFixture(ctx, project.id);

      const page1 = await ctx.app.request(
        `/projects/${project.id}/testcases?limit=2`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const html1 = await page1.text();
      expect(hasTag(html1, `testcase-row-${ids.e}`)).toBe(true);
      expect(hasTag(html1, `testcase-row-${ids.d}`)).toBe(true);
      expect(hasTag(html1, `testcase-row-${ids.c}`)).toBe(false);
      // has_more=true → <a> タグ(disabled 相当ではない)+ href に cursor が含まれる。
      const nextTag1 = findTag(html1, 'btn-next-page');
      expect(nextTag1).toMatch(/^<a /);
      const nextHref1 = attrValue(nextTag1, 'href');
      expect(nextHref1).toContain('cursor=');
      expect(nextHref1).toContain('limit=2');
      // 先頭ページには「先頭に戻る」は無い。
      expect(hasTag(html1, 'link-back-to-top')).toBe(false);

      const page2 = await ctx.app.request(nextHref1 as string, { headers: { Cookie: cookieHeader(admin.jar) } });
      const html2 = await page2.text();
      expect(hasTag(html2, `testcase-row-${ids.c}`)).toBe(true);
      expect(hasTag(html2, `testcase-row-${ids.b}`)).toBe(true);
      expect(hasTag(html2, `testcase-row-${ids.e}`)).toBe(false);
      // 2ページ目には「先頭に戻る」がある。
      expect(hasTag(html2, 'link-back-to-top')).toBe(true);
      expect(attrValue(findTag(html2, 'link-back-to-top'), 'href')).toBe(`/projects/${project.id}/testcases?limit=2`);

      // 最終ページ(残り1件)は has_more=false → btn-next-page は <span aria-disabled>。
      const nextTag2 = findTag(html2, 'btn-next-page');
      const nextHref2 = attrValue(nextTag2, 'href');
      const page3 = await ctx.app.request(nextHref2 as string, { headers: { Cookie: cookieHeader(admin.jar) } });
      const html3 = await page3.text();
      expect(hasTag(html3, `testcase-row-${ids.a}`)).toBe(true);
      const nextTag3 = findTag(html3, 'btn-next-page');
      expect(nextTag3).toMatch(/^<span /);
      expect(attrValue(nextTag3, 'aria-disabled')).toBe('true');
    });

    it('同期サマリーパネル: origin別最終同期時刻 + 非ゼロの新規/drift/stale件数(current)を表示する(D-01)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'sync-summary-svc');
      await seedFixture(ctx, project.id); // unreviewed=2(B,C) / drift=1(D) / stale=1(C) になるフィクスチャ
      const committedAt = FIXED_NOW - 100_000;
      await seedCommittedSyncSession(ctx.rawExec, {
        pid: project.id, origin: 'github-actions', committedAt, createdCount: 3, changedCount: 2, staledCount: 1,
      });

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const html = await res.text();

      expect(hasTag(html, 'sync-summary')).toBe(true);
      expect(hasTag(html, 'sync-last-time-github-actions')).toBe(true);
      // FIXED_NOW=1_700_000_000_000 → 2023-11-14T22:13:20.000Z、committedAt = FIXED_NOW-100_000。
      const d = new Date(committedAt);
      const expectedDatetime = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-`
        + `${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:`
        + `${String(d.getUTCMinutes()).padStart(2, '0')}`;
      expect(tagText(html, 'sync-last-time-github-actions')).toContain(expectedDatetime);

      // current(非ゼロ識別。notes.md「ゼロ状態のみのテストは真バグを見逃す」対策)。
      expect(tagText(html, 'sync-new-count')).toBe('新規: 2件');
      expect(tagText(html, 'sync-drift-count')).toBe('drift: 1件');
      expect(tagText(html, 'sync-stale-count')).toBe('stale: 1件');

      // 各カウントのリンク先(クリックで該当フィルタが適用される)。
      expect(attrValue(findTag(html, 'sync-new-count'), 'href')).toBe(
        `/projects/${project.id}/testcases?status=draft&ownership=machine`,
      );
      expect(attrValue(findTag(html, 'sync-drift-count'), 'href')).toBe(`/projects/${project.id}/testcases?drift=true`);
      expect(attrValue(findTag(html, 'sync-stale-count'), 'href')).toBe(`/projects/${project.id}/testcases?is_stale=true`);
    });

    it('同期データなし(committedセッション無し)→ sync-summary は非表示(ただし一覧自体は正常描画)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'no-sync-svc');
      await seedFixture(ctx, project.id);
      const res = await ctx.app.request(`/projects/${project.id}/testcases`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();
      // 「非表示」の主張が空振り(ルート自体が無い等)でないことの対照確認。
      expect(hasTag(html, 'testcase-table')).toBe(true);
      expect(hasTag(html, 'sync-summary')).toBe(false);
    });

    it('HX-Request → 一覧セクションのみのフラグメント(<html>/global-headerを含まない、testcase-list-sectionは含む)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'hx-fragment-svc');
      await seedFixture(ctx, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' } },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('<html');
      expect(html).not.toContain('global-header');
      expect(hasTag(html, 'testcase-list-section')).toBe(true);
      expect(hasTag(html, 'testcase-table')).toBe(true);
    });

    it('viewer: 一覧は見えるが作成ボタン・チェックボックス・一括操作バーは非表示', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'viewer-visibility-svc');
      const ids = await seedFixture(ctx, project.id);
      const viewer = await createUserAndLogin(ctx, admin, 'viewer-list@example.com', 'viewer');

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?limit=10`,
        { headers: { Cookie: cookieHeader(viewer.jar) } },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(hasTag(html, 'testcase-table')).toBe(true);
      expect(hasTag(html, 'btn-create-testcase')).toBe(false);
      expect(hasTag(html, 'checkbox-select-all')).toBe(false);
      expect(hasTag(html, `checkbox-row-${ids.a}`)).toBe(false);
      expect(hasTag(html, 'bulk-bar')).toBe(false);
      expect(hasTag(html, 'btn-bulk-action')).toBe(false);
    });

    it('editor: 作成ボタン・チェックボックス・一括操作バーが表示される(viewer 限定ではない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'editor-visibility-svc');
      await seedFixture(ctx, project.id);
      const editor = await createUserAndLogin(ctx, admin, 'editor-list@example.com', 'editor');

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases?limit=10`,
        { headers: { Cookie: cookieHeader(editor.jar) } },
      );
      const html = await res.text();
      expect(hasTag(html, 'btn-create-testcase')).toBe(true);
      expect(hasTag(html, 'checkbox-select-all')).toBe(true);
      expect(hasTag(html, 'bulk-bar')).toBe(true);
    });
  });

  describe('GET /projects/:pid/testcases/bulk-confirm(S-15 ダイアログ)', () => {
    it('editor + HX-Request → ダイアログフラグメントのみ(承認: 件数・アクション名・警告2種・hidden ids)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'confirm-approve-svc');
      const ids = await seedFixture(ctx, project.id);

      const res = await ctx.app.request(confirmUrl(project.id, [ids.b, ids.c], 'approve'), {
        headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('<html');

      expect(tagText(html, 'bulk-confirm-title')).toBe('一括操作の確認');
      expect(tagText(html, 'bulk-confirm-count')).toBe('2 件のテストケースを');
      expect(tagText(html, 'bulk-confirm-action-name')).toBe('「承認」');
      expect(hasTag(html, 'bulk-confirm-warning-ownership')).toBe(true);
      expect(hasTag(html, 'bulk-confirm-warning-auto-update')).toBe(true);
      expect(hasTag(html, 'bulk-confirm-warning-archive')).toBe(false);
      expect(hasTag(html, 'bulk-confirm-warning-restore')).toBe(false);

      expect(hasTag(html, 'bulk-confirm-form')).toBe(true);
      expect(hasTag(html, 'bulk-confirm-cancel')).toBe(true);
      expect(hasTag(html, 'bulk-confirm-execute')).toBe(true);
      expect(attrValue(findTag(html, 'bulk-confirm-execute'), 'disabled')).toBeNull();
      expect(html).toMatch(/<input type="hidden" name="_csrf" value="[^"]+"/);
      expect(html).toContain(`<input type="hidden" name="action" value="approve"`);
      expect(html).toContain(`<input type="hidden" name="ids[]" value="${ids.b}"`);
      expect(html).toContain(`<input type="hidden" name="ids[]" value="${ids.c}"`);
    });

    it('archive アクション → archive 専用の警告のみ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'confirm-archive-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(confirmUrl(project.id, [ids.a], 'archive'), {
        headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' },
      });
      const html = await res.text();
      expect(tagText(html, 'bulk-confirm-action-name')).toBe('「アーカイブ」');
      expect(hasTag(html, 'bulk-confirm-warning-archive')).toBe(true);
      expect(hasTag(html, 'bulk-confirm-warning-ownership')).toBe(false);
    });

    it('restore アクション → restore 専用の警告のみ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'confirm-restore-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(confirmUrl(project.id, [ids.a], 'restore'), {
        headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' },
      });
      const html = await res.text();
      expect(tagText(html, 'bulk-confirm-action-name')).toBe('「復帰」');
      expect(hasTag(html, 'bulk-confirm-warning-restore')).toBe(true);
      expect(hasTag(html, 'bulk-confirm-warning-archive')).toBe(false);
    });

    it('viewer → 403', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'confirm-viewer-svc');
      const ids = await seedFixture(ctx, project.id);
      const viewer = await createUserAndLogin(ctx, admin, 'viewer-confirm@example.com', 'viewer');
      const res = await ctx.app.request(confirmUrl(project.id, [ids.a], 'approve'), {
        headers: { Cookie: cookieHeader(viewer.jar), 'HX-Request': 'true' },
      });
      expect(res.status).toBe(403);
    });

    it('ids 無し・不正な action → ダイアログを開かず一覧へ(HXは204、非HXは303)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'confirm-invalid-svc');
      const hxRes = await ctx.app.request(`/projects/${project.id}/testcases/bulk-confirm?action=approve`, {
        headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' },
      });
      expect(hxRes.status).toBe(204);

      const plainRes = await ctx.app.request(
        `/projects/${project.id}/testcases/bulk-confirm?action=bogus-action`,
        { headers: { Cookie: cookieHeader(admin.jar) }, redirect: 'manual' },
      );
      expect(plainRes.status).toBe(303);
      expect(plainRes.headers.get('location')).toBe(`/projects/${project.id}/testcases`);
    });

    it('非HX(no-JS フォールバック)→ S-08 フルページ + ダイアログがオーバーレイ表示される', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'confirm-nojs-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(confirmUrl(project.id, [ids.a], 'approve'), { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<html');
      expect(hasTag(html, 'global-header')).toBe(true);
      expect(hasTag(html, 'testcase-table')).toBe(true);
      expect(hasTag(html, 'bulk-confirm-dialog')).toBe(true);
    });
  });

  describe('POST /projects/:pid/testcases/bulk-ui(S-15 実行)', () => {
    it('editor: 全件承認 → 200更新 + flash「N件のテストケースを承認しました」+ ステータス/所有権反映', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'bulk-approve-svc');
      const ids = await seedFixture(ctx, project.id);
      const editor = await createUserAndLogin(ctx, admin, 'editor-bulk@example.com', 'editor');

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/bulk-ui`,
        bulkFormReq([ids.b, ids.c], 'approve', editor.csrf ?? '', { Cookie: cookieHeader(editor.jar) }),
      );
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get('location') as string, 'http://x');
      expect(loc.pathname).toBe(`/projects/${project.id}/testcases`);
      expect(loc.searchParams.get('flash')).toBe('bulk_result');
      expect(loc.searchParams.get('action')).toBe('approve');
      expect(loc.searchParams.get('updated')).toBe('2');
      expect(loc.searchParams.get('skipped')).toBe('0');
      expect(loc.searchParams.get('errors')).toBe('0');

      const listRes = await ctx.app.request(
        `${loc.pathname}${loc.search}`,
        { headers: { Cookie: cookieHeader(editor.jar) } },
      );
      const html = await listRes.text();
      expect(tagText(html, 'toast')).toBe('2件のテストケースを承認しました');
      expect(findTag(html, 'toast')).toContain('toast-success');

      // 承認により draft→approved、machine→human に遷移している。
      const checkRes = await ctx.app.request(
        `/projects/${project.id}/testcases?limit=10`,
        { headers: { Cookie: cookieHeader(editor.jar) } },
      );
      const checkHtml = await checkRes.text();
      expect(tagText(checkHtml, `cell-status-${ids.b}`)).toBe('approved');
      expect(tagText(checkHtml, `cell-ownership-${ids.b}`)).toBe('👤');
      expect(tagText(checkHtml, `cell-status-${ids.c}`)).toBe('approved');
    });

    it('一部スキップ+一部エラー(NOT_FOUND)→ flash「N件を承認しました（M件でエラー発生）」(S-15優先テンプレート)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'bulk-partial-svc');
      const ids = await seedFixture(ctx, project.id);
      // ids.a は既に approved → skip、bogus は存在しない id → error、ids.b は draft → update。
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/bulk-ui`,
        bulkFormReq([ids.b, ids.a, 'bogus-id-xyz'], 'approve', admin.csrf ?? '', { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get('location') as string, 'http://x');
      expect(loc.searchParams.get('updated')).toBe('1');
      expect(loc.searchParams.get('skipped')).toBe('1');
      expect(loc.searchParams.get('errors')).toBe('1');

      const listRes = await ctx.app.request(`${loc.pathname}${loc.search}`, { headers: { Cookie: cookieHeader(admin.jar) } });
      const html = await listRes.text();
      expect(tagText(html, 'toast')).toBe('1件を承認しました（1件でエラー発生）');
      expect(findTag(html, 'toast')).toContain('toast-warn');
    });

    it('archive アクション → flash「N件のテストケースをアーカイブしました」', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'bulk-archive-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/bulk-ui`,
        bulkFormReq([ids.a], 'archive', admin.csrf ?? '', { Cookie: cookieHeader(admin.jar) }),
      );
      const loc = new URL(res.headers.get('location') as string, 'http://x');
      const listRes = await ctx.app.request(`${loc.pathname}${loc.search}`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(tagText(await listRes.text(), 'toast')).toBe('1件のテストケースをアーカイブしました');
    });

    it('viewer が POST → 403(更新されない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'bulk-viewer-403-svc');
      const ids = await seedFixture(ctx, project.id);
      const viewer = await createUserAndLogin(ctx, admin, 'viewer-bulk@example.com', 'viewer');

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/bulk-ui`,
        bulkFormReq([ids.b], 'approve', viewer.csrf ?? '', { Cookie: cookieHeader(viewer.jar) }),
      );
      expect(res.status).toBe(403);

      const checkRes = await ctx.app.request(
        `/projects/${project.id}/testcases?limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(tagText(await checkRes.text(), `cell-status-${ids.b}`)).toBe('draft');
    });

    it('CSRF トークン無し → 403(更新されない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'bulk-nocsrf-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/bulk-ui`,
        formReq({ 'ids[]': ids.b, action: 'approve' }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(403);
    });

    it('選択0件(ids 無し)で改ざんPOST → 303 でエラーにならず一覧へ(何も更新しない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'bulk-empty-ids-svc');
      const ids = await seedFixture(ctx, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/bulk-ui`,
        formReq({ action: 'approve', _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(303);
      const checkRes = await ctx.app.request(
        `/projects/${project.id}/testcases?limit=10`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(tagText(await checkRes.text(), `cell-status-${ids.b}`)).toBe('draft');
    });

    it('プロジェクト未存在 → 404(このルート専用の404ページ。素通りの汎用404と区別する)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const res = await ctx.app.request(
        '/projects/does-not-exist/testcases/bulk-ui',
        bulkFormReq(['whatever'], 'approve', admin.csrf ?? '', { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(404);
      expect(tagText(await res.text(), 'page-404-title')).toBe('プロジェクトが見つかりません');
    });
  });
});
