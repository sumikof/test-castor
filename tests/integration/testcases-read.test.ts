// tests/integration/testcases-read.test.ts
// テストケース Storage 拡張 + 読み取り系 API(作成含む)の統合テスト(task-13-brief.md「振る舞い」を1行ずつ検証する)。
// docs/apis/testcases.md(一覧・単体・作成・履歴・gherkin)、api-reference.md(カーソルページング・コレクション応答)、
// スペック D-03(exact total)/D-04(actor_display)/D-05(updated_at 意味論)と1:1で対応させる(GC-1)。
// 実 D1(miniflare binding)+ 固定クロックを使う(tests/integration/helpers.ts)。
//
// GC-1 メモ: docs/apis/testcases.md の一覧レスポンス例・フィールド表には `total` が無く、履歴の
// フィールド表にも `actor_display` が無い。だがスペック D-03(「正確な total を返す」)・D-04
// (履歴に actor_display を追加)はこれらを明記しており、global-constraints.md「スペックと docs/ の
// 記述が異なる箇所はスペックが優先」に従いスペックどおり実装する。非破壊な追加フィールドのため
// api-reference.md のバージョニング規約上も問題ない。タスク報告にこの docs 記載漏れを明示する。
import { describe, it, expect, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import type { AppEnv } from '../../src/http/app';
import {
  makeTestApp, wipe, cookieHeader, setupAndLogin, loginAs, createProject, issueToken, FIXED_NOW, type TestApp,
} from './helpers';
import { renderGherkin } from '../../src/domain/gherkin';

function jsonReq(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** admin セッションで editor/viewer ユーザーを作成しログインする(projects.test.ts/tokens.test.ts と同じ規約をローカル化)。 */
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

const FULL_TC_BODY = {
  title: '残高不足時にエラーを返す',
  target: 'com.example.PaymentService#charge',
  category: 'error_handling' as const,
  given: 'ユーザーの残高が100円未満',
  when: '1000円の支払いを実行',
  then: 'InsufficientBalanceError が発生する',
  parameters: [
    { inputs: { balance: 50, amount: 1000 }, expected: 'error' },
    { inputs: { balance: 0, amount: 500 }, expected: 'error' },
  ],
  metadata: { tags: ['payment', 'error'] },
};

/** POST /api/v1/projects/:pid/testcases を実行する(本ファイル専用ヘルパ)。 */
async function postTestCase(
  app: Hono<AppEnv>,
  actorCtx: { jar: Record<string, string>; csrf?: string },
  pid: string,
  body: Record<string, unknown> = FULL_TC_BODY,
) {
  return app.request(
    `/api/v1/projects/${pid}/testcases`,
    jsonReq('POST', body, { Cookie: cookieHeader(actorCtx.jar), 'x-csrf-token': actorCtx.csrf ?? '' }),
  );
}

describe('統合: テストケース Storage拡張 + 読み取り系 API', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec); // D1 はテスト間で状態が残るため毎回ワイプする
  });

  describe('POST /api/v1/projects/:pid/testcases(apis/testcases.md)', () => {
    it('admin(editor以上): 201 + ETag: W/"1" + 全21フィールド(GET単体と同一構造)+ ownership=human/created_origin=manual', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');

      const res = await postTestCase(ctx.app, admin, project.body.id);
      expect(res.status).toBe(201);
      expect(res.headers.get('etag')).toBe('W/"1"');

      const body = await res.json<any>();
      expect(body).toEqual({
        id: expect.any(String),
        title: FULL_TC_BODY.title,
        target: FULL_TC_BODY.target,
        category: FULL_TC_BODY.category,
        given: FULL_TC_BODY.given,
        when: FULL_TC_BODY.when,
        then: FULL_TC_BODY.then,
        parameters: FULL_TC_BODY.parameters,
        status: 'draft',
        is_stale: false,
        ownership: 'human',
        mirror_origin: null,
        drift: false,
        fingerprint: null,
        version: 1,
        confidence: null,
        source_ref: null,
        created_origin: 'manual',
        metadata: FULL_TC_BODY.metadata,
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
      });
      expect(Object.keys(body).sort()).toEqual(
        [
          'category', 'confidence', 'created_at', 'created_origin', 'drift', 'fingerprint', 'given',
          'id', 'is_stale', 'metadata', 'mirror_origin', 'ownership', 'parameters', 'source_ref',
          'status', 'target', 'then', 'title', 'updated_at', 'version', 'when',
        ].sort(),
      );
    });

    it('status を明示指定すると尊重される(未指定時の既定は draft)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, status: 'approved' });
      expect(res.status).toBe(201);
      expect((await res.json<any>()).status).toBe('approved');
    });

    it('必須フィールド欠落(title)→ 422 VALIDATION_FAILED', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const { title: _title, ...withoutTitle } = FULL_TC_BODY;
      const res = await postTestCase(ctx.app, admin, project.body.id, withoutTitle);
      expect(res.status).toBe(422);
      expect((await res.json<any>()).error.code).toBe('VALIDATION_FAILED');
    });

    it('editor: 201(editor 以上で作成可能)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const editor = await loginAsRole(ctx, admin, 'editor', 'editor@example.com');
      const res = await postTestCase(ctx.app, editor, project.body.id);
      expect(res.status).toBe(201);
    });

    it('viewer: 403 FORBIDDEN(editor 未満)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer@example.com');
      const res = await postTestCase(ctx.app, viewer, project.body.id);
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('Bearer トークン: 403 FORBIDDEN(POST は session 専用ルート宣言。能力マトリクス)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const plaintext = await issueToken(ctx.app, admin, project.body.id, 'discovery-ci');
      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases`,
        jsonReq('POST', FULL_TC_BODY, { Authorization: `Bearer ${plaintext}` }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('他 org の :pid → 404(存在隠蔽)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const otherOrg = await ctx.storage.setupOrganization({
        orgName: 'Other Org', adminEmail: 'other-admin-tc-post@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin', now: FIXED_NOW,
      });
      const otherProject = await ctx.storage.createProject(
        { organizationId: otherOrg.organization.id }, { name: 'other-org-project' }, FIXED_NOW,
      );
      const res = await postTestCase(ctx.app, admin, otherProject.id);
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/projects/:pid/testcases(apis/testcases.md)', () => {
    it('0件: 200 {items:[],total:0,next_cursor:null,has_more:false}', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/testcases`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      expect(await res.json<any>()).toEqual({ items: [], total: 0, next_cursor: null, has_more: false });
    });

    it('一覧アイテムは11フィールドのサブセット。total は正確値(D-03)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();

      const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/testcases`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.total).toBe(1);
      expect(body.has_more).toBe(false);
      expect(body.next_cursor).toBeNull();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toEqual({
        id: createdBody.id,
        title: createdBody.title,
        target: createdBody.target,
        category: createdBody.category,
        status: createdBody.status,
        ownership: createdBody.ownership,
        is_stale: createdBody.is_stale,
        drift: createdBody.drift,
        version: createdBody.version,
        created_at: createdBody.created_at,
        updated_at: createdBody.updated_at,
      });
      expect(Object.keys(body.items[0]).sort()).toEqual(
        ['category', 'created_at', 'drift', 'id', 'is_stale', 'ownership', 'status', 'target', 'title', 'updated_at', 'version'].sort(),
      );
    });

    it('クエリ ?status=draft&ownership=human&target=Payment はAND結合で絞り込む', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const match = await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, title: 'match', status: 'draft' });
      const matchBody = await match.json<any>();
      await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, title: 'wrong-status', status: 'approved' });
      await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, title: 'wrong-target', target: 'com.example.UserService#login' });

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases?status=draft&ownership=human&target=Payment`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.items.map((i: any) => i.id)).toEqual([matchBody.id]);
      expect(body.total).toBe(1);
    });

    it('?drift=true は drift フラグで絞り込む(drift への遷移はPATCH等の別経路のため、storage 直経由で1件用意する)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const driftTc = await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, title: 'drifted' });
      const driftBody = await driftTc.json<any>();
      await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, title: 'not-drifted' });
      await ctx.rawExec(`UPDATE test_cases SET drift = 1 WHERE id = '${driftBody.id}'`);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases?drift=true`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.items.map((i: any) => i.id)).toEqual([driftBody.id]);
      expect(body.items[0].drift).toBe(true);
    });

    it('limit 指定でページング: has_more/next_cursor がカーソルベースで次ページに正しく連続する', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, title: 'first' });
      ctx.advance(1);
      await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, title: 'second' });

      const page1 = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases?limit=1`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const page1Body = await page1.json<any>();
      expect(page1Body.items).toHaveLength(1);
      expect(page1Body.has_more).toBe(true);
      expect(page1Body.total).toBe(2);
      expect(page1Body.next_cursor).not.toBeNull();

      const page2 = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases?limit=1&cursor=${encodeURIComponent(page1Body.next_cursor)}`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const page2Body = await page2.json<any>();
      expect(page2Body.items).toHaveLength(1);
      expect(page2Body.has_more).toBe(false);
      expect(page2Body.total).toBe(2);
      expect(page2Body.items[0].id).not.toBe(page1Body.items[0].id);
    });

    it('viewer: 200(閲覧可)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-list@example.com');
      const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/testcases`, { headers: { Cookie: cookieHeader(viewer.jar) } });
      expect(res.status).toBe(200);
    });

    it('Bearer トークン: 200(自 project の参照系 GET は到達可能。能力マトリクス)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const plaintext = await issueToken(ctx.app, admin, project.body.id, 'discovery-ci');
      const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/testcases`, { headers: { Authorization: `Bearer ${plaintext}` } });
      expect(res.status).toBe(200);
    });

    it('他 org の :pid → 404(存在隠蔽)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const otherOrg = await ctx.storage.setupOrganization({
        orgName: 'Other Org', adminEmail: 'other-admin-tc-list@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin', now: FIXED_NOW,
      });
      const otherProject = await ctx.storage.createProject(
        { organizationId: otherOrg.organization.id }, { name: 'other-org-project' }, FIXED_NOW,
      );
      const res = await ctx.app.request(`/api/v1/projects/${otherProject.id}/testcases`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/projects/:pid/testcases/:id(apis/testcases.md)', () => {
    it('200 + ETag + 全フィールド(POSTレスポンスと同一構造)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();

      const res = await ctx.app.request(`/api/v1/projects/${project.body.id}/testcases/${createdBody.id}`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toBe('W/"1"');
      expect(await res.json<any>()).toEqual(createdBody);
    });

    it('存在しない :id → 404', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/00000000-0000-0000-0000-000000000000`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });

    it('他 org の :pid → 404(存在隠蔽。テストケースは正しい project に存在するが、要求元 org からは見えない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();

      const otherOrg = await ctx.storage.setupOrganization({
        orgName: 'Other Org', adminEmail: 'other-admin-tc-get@example.com', adminPasswordHash: 'unused', adminDisplayName: 'Other Admin', now: FIXED_NOW,
      });
      const otherProject = await ctx.storage.createProject(
        { organizationId: otherOrg.organization.id }, { name: 'other-org-project' }, FIXED_NOW,
      );
      const res = await ctx.app.request(
        `/api/v1/projects/${otherProject.id}/testcases/${createdBody.id}`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });

    it('viewer: 200(閲覧可)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-get@example.com');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${createdBody.id}`,
        { headers: { Cookie: cookieHeader(viewer.jar) } },
      );
      expect(res.status).toBe(200);
    });

    it('Bearer トークン: 200(自 project の参照系 GET は到達可能)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();
      const plaintext = await issueToken(ctx.app, admin, project.body.id, 'discovery-ci');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${createdBody.id}`,
        { headers: { Authorization: `Bearer ${plaintext}` } },
      );
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/v1/projects/:pid/testcases/:id?format=gherkin(apis/testcases.md)', () => {
    it('200 + Content-Type: text/plain; charset=utf-8。本文は domain/renderGherkin の出力と完全一致する', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${createdBody.id}?format=gherkin`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      const text = await res.text();
      const expected = renderGherkin({
        title: FULL_TC_BODY.title,
        target: FULL_TC_BODY.target,
        given: FULL_TC_BODY.given,
        when: FULL_TC_BODY.when,
        then: FULL_TC_BODY.then,
        parameters: FULL_TC_BODY.parameters,
      });
      expect(text).toBe(expected);
    });
  });

  describe('GET /api/v1/projects/:pid/testcases/:id/history(apis/testcases.md, D-04)', () => {
    it('200 {items,total,next_cursor,has_more}。作成直後は created 1件で actor_display は作成者の display_name', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${createdBody.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.total).toBe(1);
      expect(body.has_more).toBe(false);
      expect(body.next_cursor).toBeNull();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        test_case_id: createdBody.id,
        action: 'created',
        delta: {},
        created_at: FIXED_NOW,
        actor_display: 'Admin Taro', // DEFAULT_SETUP_BODY.admin_display_name(helpers.ts)
      });
      expect(body.items[0].actor).toMatch(/^user:/);
      expect(typeof body.items[0].id).toBe('string');
    });

    it('存在しない :id → 404', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/00000000-0000-0000-0000-000000000000/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });

    it('viewer: 200(閲覧可)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-hist@example.com');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${createdBody.id}/history`,
        { headers: { Cookie: cookieHeader(viewer.jar) } },
      );
      expect(res.status).toBe(200);
    });

    it('Bearer トークン: 200(自 project の参照系 GET は到達可能)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const createdBody = await created.json<any>();
      const plaintext = await issueToken(ctx.app, admin, project.body.id, 'discovery-ci');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${createdBody.id}/history`,
        { headers: { Authorization: `Bearer ${plaintext}` } },
      );
      expect(res.status).toBe(200);
    });
  });
});
