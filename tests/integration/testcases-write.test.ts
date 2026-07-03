// tests/integration/testcases-write.test.ts
// テストケース書き込み系 API(task-14-brief.md「振る舞い」を1行ずつ検証する)。
// docs/apis/testcases.md(PATCH/DELETE/bulk/accept-fingerprint/diff/observations/identities の全仕様・
// エラー表)、api-reference.md(OCC・If-Match・PATCH セマンティクス)、data-model.md(OCC・履歴不変条件)、
// スペック D-02(DELETE=archive のセマンティックエイリアス)と1:1で対応させる(GC-1)。
// 実 D1(miniflare binding)+ 固定クロックを使う(tests/integration/helpers.ts)。drift/diff/observations の
// 統合テストは Task 15/16 の同期実装に依存せず、helpers-seed.ts の seedCommittedObservation で
// committed な sync_sessions/observations/identities 行を直接作る。
import { describe, it, expect, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import type { AppEnv } from '../../src/http/app';
import {
  makeTestApp, wipe, cookieHeader, setupAndLogin, loginAs, createProject, issueToken, FIXED_NOW, type TestApp,
} from './helpers';
import { seedCommittedObservation } from './helpers-seed';

function jsonReq(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** admin セッションで editor/viewer ユーザーを作成しログインする(既存 read テストと同じ規約をローカル化)。 */
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
  title: '正常な支払い処理',
  target: 'com.example.PaymentService#charge',
  category: 'normal' as const,
  given: 'ユーザーの残高が十分にある',
  when: '500円の支払いを実行',
  then: '支払いが成功し残高が500円減少する',
  parameters: [{ inputs: { balance: 1000, amount: 500 }, expected: 'ok' }],
  metadata: { tags: ['payment'] },
};

async function postTestCase(
  app: Hono<AppEnv>,
  actorCtx: { jar: Record<string, string>; csrf?: string },
  pid: string,
  body: Record<string, unknown> = FULL_TC_BODY,
) {
  const res = await app.request(
    `/api/v1/projects/${pid}/testcases`,
    jsonReq('POST', body, { Cookie: cookieHeader(actorCtx.jar), 'x-csrf-token': actorCtx.csrf ?? '' }),
  );
  return res.json<any>();
}

function authHeaders(actorCtx: { jar: Record<string, string>; csrf?: string }, extra: Record<string, string> = {}) {
  return { Cookie: cookieHeader(actorCtx.jar), 'x-csrf-token': actorCtx.csrf ?? '', ...extra };
}

const OBSERVED_FIXTURE = (then: string) => ({
  title: 't', given: 'g', when: 'w', then, parameters: [], source_ref: { file: 'X.java', line: 1 }, schema_version: '1.0',
});

describe('統合: テストケース書き込み系 API', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec);
  });

  describe('PATCH /api/v1/projects/:pid/testcases/:id(apis/testcases.md, OCC)', () => {
    it('If-Match ヘッダなし → 428 PRECONDITION_REQUIRED', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: 'x' }, authHeaders(admin)),
      );
      expect(res.status).toBe(428);
      expect((await res.json<any>()).error.code).toBe('PRECONDITION_REQUIRED');
    });

    it('If-Match は `"3"` 形式・`W/"3"` 形式のいずれも受理し version として比較する', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await ctx.rawExec(`UPDATE test_cases SET version = 3 WHERE id = '${created.id}'`);

      const resPlain = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: 'plain-form' }, authHeaders(admin, { 'If-Match': '"3"' })),
      );
      expect(resPlain.status).toBe(200);
      expect((await resPlain.json<any>()).version).toBe(4);

      const resWeak = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: 'weak-form' }, authHeaders(admin, { 'If-Match': 'W/"4"' })),
      );
      expect(resWeak.status).toBe(200);
      expect((await resWeak.json<any>()).version).toBe(5);
    });

    it('version 不一致 → 409 OCC_CONFLICT', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: 'x' }, authHeaders(admin, { 'If-Match': '"99"' })),
      );
      expect(res.status).toBe(409);
      expect((await res.json<any>()).error.code).toBe('OCC_CONFLICT');
    });

    it('machine 所有行への実変更 PATCH: ownership が human に遷移・version+1・履歴に updated と status_changed が記録される', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await ctx.rawExec(`UPDATE test_cases SET ownership = 'machine' WHERE id = '${created.id}'`);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: '新タイトル', status: 'approved' }, authHeaders(admin, { 'If-Match': '"1"' })),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toBe('W/"2"');
      const body = await res.json<any>();
      expect(body.ownership).toBe('human');
      expect(body.version).toBe(2);
      expect(body.title).toBe('新タイトル');
      expect(body.status).toBe('approved');

      const historyRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const actions = (await historyRes.json<any>()).items.map((h: any) => h.action);
      expect(actions).toEqual(expect.arrayContaining(['updated', 'status_changed']));
    });

    it('同値 no-op PATCH: 200 現行値のまま・version 不変・ownership 不変・履歴が増えない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);

      const historyBefore = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const totalBefore = (await historyBefore.json<any>()).total;

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: created.title, category: created.category }, authHeaders(admin, { 'If-Match': '"1"' })),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toBe('W/"1"');
      const body = await res.json<any>();
      expect(body.version).toBe(1);
      expect(body.ownership).toBe(created.ownership);
      expect(body.title).toBe(created.title);

      const historyAfter = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect((await historyAfter.json<any>()).total).toBe(totalBefore);
    });

    it('machine 所有行への同値 no-op PATCH では ownership 遷移が発生しない(data-model.md「同値PATCHでは遷移しない」)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await ctx.rawExec(`UPDATE test_cases SET ownership = 'machine' WHERE id = '${created.id}'`);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: created.title }, authHeaders(admin, { 'If-Match': '"1"' })),
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.ownership).toBe('machine'); // 遷移しない
      expect(body.version).toBe(1);
    });

    it('設計判断: no-op PATCH は何も書き込まないため If-Match が古い version でも 200 を返す(OCC 再検証はしない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await ctx.rawExec(`UPDATE test_cases SET version = 5 WHERE id = '${created.id}'`);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: created.title }, authHeaders(admin, { 'If-Match': '"1"' })), // 古い version
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.version).toBe(5); // 不変のまま
    });

    // review round 1(Important #3)。source_ref は data-model.md「列の二分」の人間所有列に含まれない
    // provenance 列であり、PATCH では書き込まれない(値は作成時にのみ確定する)。修正前はここで
    // computeHumanPatch を迂回して別途カラム代入しており、version bump も history 記録も無いまま
    // source_ref だけが変わる監査ギャップだった。
    it('source_ref は PATCH で書き込まれない(provenance 列。data-model.md「列の二分」): source_ref のみの PATCH は no-op(200・version不変・履歴増えず)、他フィールドと同時でも保存値は不変', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      expect(created.source_ref).toBeNull();

      const historyBefore = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const totalBefore = (await historyBefore.json<any>()).total;

      // source_ref のみを変更する PATCH: computeHumanPatch の対象外のため changes が空になり、
      // ルートの no-op 分岐(data-model.md「同値PATCH(no-op)では遷移しない」相当の扱い)に入る。
      // 200 は返るが version は bump されず、保存値も変化しない。
      const res1 = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { source_ref: { file: 'Y.java', line: 42 } }, authHeaders(admin, { 'If-Match': '"1"' })),
      );
      expect(res1.status).toBe(200);
      const body1 = await res1.json<any>();
      expect(body1.source_ref).toBeNull(); // 書き込まれていない
      expect(body1.version).toBe(1); // no-op のため不変

      const historyAfter1 = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect((await historyAfter1.json<any>()).total).toBe(totalBefore); // 履歴も増えない

      // source_ref + 実フィールド変更を同時に送っても、version bump は実フィールド由来のみ・
      // source_ref は依然として書き込まれない(バージョン挙動は他フィールドどおり)。
      const res2 = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: '新タイトル2', source_ref: { file: 'Z.java', line: 7 } }, authHeaders(admin, { 'If-Match': '"1"' })),
      );
      expect(res2.status).toBe(200);
      const body2 = await res2.json<any>();
      expect(body2.title).toBe('新タイトル2');
      expect(body2.version).toBe(2); // title の実変更により bump(source_ref 由来ではない)
      expect(body2.source_ref).toBeNull(); // それでも source_ref は書き込まれない
    });

    it('status: archived→approved は 422 VALIDATION_FAILED(遷移マトリクス違反)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, status: 'archived' });

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { status: 'approved' }, authHeaders(admin, { 'If-Match': '"1"' })),
      );
      expect(res.status).toBe(422);
      expect((await res.json<any>()).error.code).toBe('VALIDATION_FAILED');
    });

    it('存在しない :id → 404', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/00000000-0000-0000-0000-000000000000`,
        jsonReq('PATCH', { title: 'x' }, authHeaders(admin, { 'If-Match': '"1"' })),
      );
      expect(res.status).toBe(404);
      expect((await res.json<any>()).error.code).toBe('NOT_FOUND');
    });

    it('viewer: 403 FORBIDDEN(editor 未満)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-patch@example.com');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: 'x' }, authHeaders(viewer, { 'If-Match': '"1"' })),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });

    it('Bearer トークン: 403 FORBIDDEN(PATCH は session 専用ルート宣言)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const plaintext = await issueToken(ctx.app, admin, project.body.id, 'discovery-ci');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        jsonReq('PATCH', { title: 'x' }, { Authorization: `Bearer ${plaintext}`, 'If-Match': '"1"' }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
    });
  });

  describe('DELETE /api/v1/projects/:pid/testcases/:id(D-02: archive のセマンティックエイリアス)', () => {
    it('archive と同義(status=archived)・冪等(2回目も200・変化なし)・OCC 不要(If-Match なしでも200)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);

      const res1 = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        { method: 'DELETE', headers: authHeaders(admin) },
      );
      expect(res1.status).toBe(200);
      const body1 = await res1.json<any>();
      expect(body1.status).toBe('archived');
      expect(body1.version).toBe(2);

      const res2 = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        { method: 'DELETE', headers: authHeaders(admin) },
      );
      expect(res2.status).toBe(200);
      const body2 = await res2.json<any>();
      expect(body2.status).toBe('archived');
      expect(body2.version).toBe(2); // 変化なし(冪等)
    });

    it('machine 所有行の archive は ownership を human に遷移する(複合不変条件)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await ctx.rawExec(`UPDATE test_cases SET ownership = 'machine' WHERE id = '${created.id}'`);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        { method: 'DELETE', headers: authHeaders(admin) },
      );
      const body = await res.json<any>();
      expect(body.ownership).toBe('human');
      expect(body.status).toBe('archived');
    });

    it('存在しない :id → 404', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/00000000-0000-0000-0000-000000000000`,
        { method: 'DELETE', headers: authHeaders(admin) },
      );
      expect(res.status).toBe(404);
    });

    it('viewer: 403 FORBIDDEN', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-delete@example.com');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}`,
        { method: 'DELETE', headers: authHeaders(viewer) },
      );
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/projects/:pid/testcases/bulk(apis/testcases.md)', () => {
    it('approve: [draft, approved済, archived] → updated=1/skipped=1/errors=1(archived, VALIDATION_FAILED)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const draft = await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, title: 'draft-tc' });
      const approved = await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, title: 'approved-tc', status: 'approved' });
      const archived = await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, title: 'archived-tc', status: 'archived' });

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/bulk`,
        jsonReq('POST', { ids: [draft.id, approved.id, archived.id], action: 'approve' }, authHeaders(admin)),
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.updated).toBe(1);
      expect(body.skipped).toBe(1);
      expect(body.errors).toEqual([{ id: archived.id, code: 'VALIDATION_FAILED', message: expect.any(String) }]);

      const check = await ctx.app.request(`/api/v1/projects/${project.body.id}/testcases/${draft.id}`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect((await check.json<any>()).status).toBe('approved');
    });

    it('approve で machine 行は human に遷移する(履歴に status_changed が記録される)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await ctx.rawExec(`UPDATE test_cases SET ownership = 'machine' WHERE id = '${created.id}'`);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/bulk`,
        jsonReq('POST', { ids: [created.id], action: 'approve' }, authHeaders(admin)),
      );
      expect((await res.json<any>()).updated).toBe(1);

      const check = await ctx.app.request(`/api/v1/projects/${project.body.id}/testcases/${created.id}`, { headers: { Cookie: cookieHeader(admin.jar) } });
      const checkBody = await check.json<any>();
      expect(checkBody.ownership).toBe('human');
      expect(checkBody.status).toBe('approved');

      const historyRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect((await historyRes.json<any>()).items.some((h: any) => h.action === 'status_changed')).toBe(true);
    });

    it('restore: archived→draft。非 archived は skip', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const archived = await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, status: 'archived' });
      const draft = await postTestCase(ctx.app, admin, project.body.id);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/bulk`,
        jsonReq('POST', { ids: [archived.id, draft.id], action: 'restore' }, authHeaders(admin)),
      );
      const body = await res.json<any>();
      expect(body.updated).toBe(1);
      expect(body.skipped).toBe(1);
      expect(body.errors).toEqual([]);

      const check = await ctx.app.request(`/api/v1/projects/${project.body.id}/testcases/${archived.id}`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect((await check.json<any>()).status).toBe('draft');
    });

    it('archive: draft/approved → archived。個別の history が記録される', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const draft = await postTestCase(ctx.app, admin, project.body.id);
      const approved = await postTestCase(ctx.app, admin, project.body.id, { ...FULL_TC_BODY, status: 'approved' });

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/bulk`,
        jsonReq('POST', { ids: [draft.id, approved.id], action: 'archive' }, authHeaders(admin)),
      );
      const body = await res.json<any>();
      expect(body.updated).toBe(2);
      expect(body.errors).toEqual([]);

      const checkDraft = await ctx.app.request(`/api/v1/projects/${project.body.id}/testcases/${draft.id}`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect((await checkDraft.json<any>()).status).toBe('archived');

      const historyRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${draft.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect((await historyRes.json<any>()).items.some((h: any) => h.action === 'status_changed')).toBe(true);
    });

    it('存在しない id は errors に NOT_FOUND として計上される', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const missingId = '00000000-0000-0000-0000-0000000000aa';

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/bulk`,
        jsonReq('POST', { ids: [missingId], action: 'approve' }, authHeaders(admin)),
      );
      const body = await res.json<any>();
      expect(body.updated).toBe(0);
      expect(body.errors).toEqual([{ id: missingId, code: 'NOT_FOUND', message: expect.any(String) }]);
    });

    it('ids 101件 → 422 VALIDATION_FAILED(最大100件)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/bulk`,
        jsonReq('POST', { ids, action: 'approve' }, authHeaders(admin)),
      );
      expect(res.status).toBe(422);
      expect((await res.json<any>()).error.code).toBe('VALIDATION_FAILED');
    });

    it('viewer: 403 FORBIDDEN', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-bulk@example.com');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/bulk`,
        jsonReq('POST', { ids: [created.id], action: 'approve' }, authHeaders(viewer)),
      );
      expect(res.status).toBe(403);
    });

    it('Bearer トークン: 403 FORBIDDEN(session 専用ルート宣言)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const plaintext = await issueToken(ctx.app, admin, project.body.id, 'discovery-ci');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/bulk`,
        jsonReq('POST', { ids: [created.id], action: 'approve' }, { Authorization: `Bearer ${plaintext}` }),
      );
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/projects/:pid/testcases/:id/accept-fingerprint(apis/testcases.md)', () => {
    it('drift 行: 200 {id,fingerprint(最新committed観測値),drift:false,version+1,updated_at}・履歴に status_changed', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await ctx.rawExec(
        `UPDATE test_cases SET drift = 1, fingerprint = 'old-fp', mirror_origin = 'discovery-v1' WHERE id = '${created.id}'`,
      );
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.body.id, testCaseId: created.id, externalRef: 'ext-1', origin: 'discovery-v1',
        fingerprint: 'new-fp', observed: OBSERVED_FIXTURE('新しい期待結果'), at: FIXED_NOW + 1000,
      });

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/accept-fingerprint`,
        { method: 'POST', headers: authHeaders(admin, { 'If-Match': '"1"' }) },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('etag')).toBe('W/"2"');
      const body = await res.json<any>();
      expect(body).toEqual({ id: created.id, fingerprint: 'new-fp', drift: false, version: 2, updated_at: expect.any(Number) });

      const historyRes = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/history`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect((await historyRes.json<any>()).items.some((h: any) => h.action === 'status_changed')).toBe(true);

      const check = await ctx.app.request(`/api/v1/projects/${project.body.id}/testcases/${created.id}`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect((await check.json<any>()).drift).toBe(false);
    });

    it('drift なし: 422 NO_DRIFT', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/accept-fingerprint`,
        { method: 'POST', headers: authHeaders(admin, { 'If-Match': '"1"' }) },
      );
      expect(res.status).toBe(422);
      expect((await res.json<any>()).error.code).toBe('NO_DRIFT');
    });

    it('If-Match ヘッダなし → 428 PRECONDITION_REQUIRED', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/accept-fingerprint`,
        { method: 'POST', headers: authHeaders(admin) },
      );
      expect(res.status).toBe(428);
      expect((await res.json<any>()).error.code).toBe('PRECONDITION_REQUIRED');
    });

    it('version 不一致 → 409 OCC_CONFLICT', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await ctx.rawExec(
        `UPDATE test_cases SET drift = 1, fingerprint = 'old-fp', mirror_origin = 'discovery-v1' WHERE id = '${created.id}'`,
      );
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.body.id, testCaseId: created.id, externalRef: 'ext-1', origin: 'discovery-v1',
        fingerprint: 'new-fp', observed: OBSERVED_FIXTURE('別の期待結果'), at: FIXED_NOW + 1000,
      });

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/accept-fingerprint`,
        { method: 'POST', headers: authHeaders(admin, { 'If-Match': '"99"' }) },
      );
      expect(res.status).toBe(409);
      expect((await res.json<any>()).error.code).toBe('OCC_CONFLICT');
    });

    it('存在しない :id → 404', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/00000000-0000-0000-0000-000000000000/accept-fingerprint`,
        { method: 'POST', headers: authHeaders(admin, { 'If-Match': '"1"' }) },
      );
      expect(res.status).toBe(404);
    });

    it('viewer: 403 FORBIDDEN', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-fp@example.com');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/accept-fingerprint`,
        { method: 'POST', headers: authHeaders(viewer, { 'If-Match': '"1"' }) },
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v1/projects/:pid/testcases/:id/diff(apis/testcases.md)', () => {
    it('drift 行: has_drift:true + origin/observed_at/canonical/latest_observation/diff(差分フィールドのみ)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await ctx.rawExec(
        `UPDATE test_cases SET drift = 1, fingerprint = 'old-fp', mirror_origin = 'discovery-v1' WHERE id = '${created.id}'`,
      );
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.body.id, testCaseId: created.id, externalRef: 'ext-1', origin: 'discovery-v1', fingerprint: 'new-fp',
        observed: {
          title: 't', given: created.given, when: created.when, then: '新しい期待結果', parameters: created.parameters,
          source_ref: {}, schema_version: '1.0',
        },
        at: FIXED_NOW + 1000,
      });

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/diff`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.has_drift).toBe(true);
      expect(body.origin).toBe('discovery-v1');
      expect(body.observed_at).toBe(FIXED_NOW + 1000);
      expect(body.canonical).toEqual({
        given: created.given, when: created.when, then: created.then, parameters: created.parameters,
      });
      expect(body.latest_observation).toEqual({
        given: created.given, when: created.when, then: '新しい期待結果', parameters: created.parameters,
      });
      expect(body.diff).toEqual({ then: { before: created.then, after: '新しい期待結果' } });
    });

    it('drift なし: has_drift:false + origin/observed_at/latest_observation/diff は null', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/diff`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(200);
      expect(await res.json<any>()).toEqual({
        has_drift: false,
        origin: null,
        observed_at: null,
        canonical: { given: created.given, when: created.when, then: created.then, parameters: created.parameters },
        latest_observation: null,
        diff: null,
      });
    });

    it('存在しない :id → 404', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/00000000-0000-0000-0000-000000000000/diff`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(404);
    });

    it('viewer: 200(閲覧可)・Bearer トークン: 200(自 project の参照系 GET は到達可能)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const viewer = await loginAsRole(ctx, admin, 'viewer', 'viewer-diff@example.com');
      const plaintext = await issueToken(ctx.app, admin, project.body.id, 'discovery-ci');

      const resViewer = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/diff`,
        { headers: { Cookie: cookieHeader(viewer.jar) } },
      );
      expect(resViewer.status).toBe(200);

      const resToken = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/diff`,
        { headers: { Authorization: `Bearer ${plaintext}` } },
      );
      expect(resToken.status).toBe(200);
    });
  });

  describe('GET /api/v1/projects/:pid/testcases/:id/observations(apis/testcases.md)', () => {
    it('committed のみ(active セッション由来は除外)。observed は6フィールドのサブセット', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.body.id, testCaseId: created.id, externalRef: 'ext-1', origin: 'discovery-v1',
        fingerprint: 'fp-committed', observed: OBSERVED_FIXTURE('t'), at: FIXED_NOW + 1000,
      });
      // active セッション由来は seedCommittedObservation(committed 固定)を使わず直接 rawExec で作る。
      await ctx.rawExec(
        `INSERT INTO sync_sessions (token, project_id, origin, status, started_at, expires_at) ` +
        `VALUES ('active-sess', '${project.body.id}', 'discovery-v1', 'active', ${FIXED_NOW}, ${FIXED_NOW + 600000})`,
      );
      await ctx.rawExec(
        `INSERT INTO test_case_observations (id, test_case_id, external_ref, project_id, fingerprint, observed, sync_token, origin, created_at) ` +
        `VALUES ('obs-active', '${created.id}', 'ext-1', '${project.body.id}', 'fp-active', '{}', 'active-sess', 'discovery-v1', ${FIXED_NOW + 2000})`,
      );

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/observations`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.total).toBe(1);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].fingerprint).toBe('fp-committed');
      expect(body.items[0].origin).toBe('discovery-v1');
      expect(body.items[0].observed).toEqual({
        given: 'g', when: 'w', then: 't', parameters: [], source_ref: { file: 'X.java', line: 1 }, schema_version: '1.0',
      });
      expect(Object.keys(body.items[0]).sort()).toEqual(['created_at', 'fingerprint', 'id', 'observed', 'origin'].sort());
    });

    it('origin フィルタで絞り込む', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.body.id, testCaseId: created.id, externalRef: 'ext-1', origin: 'discovery-v1',
        fingerprint: 'fp-v1', observed: OBSERVED_FIXTURE('t'), at: FIXED_NOW + 1000,
      });
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.body.id, testCaseId: created.id, externalRef: 'ext-2', origin: 'discovery-v2',
        fingerprint: 'fp-v2', observed: OBSERVED_FIXTURE('t'), at: FIXED_NOW + 2000,
      });

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/observations?origin=discovery-v1`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const body = await res.json<any>();
      expect(body.items.map((i: any) => i.origin)).toEqual(['discovery-v1']);
    });

    it('limit 指定でページング: has_more/next_cursor がカーソルベースで次ページに正しく連続する', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.body.id, testCaseId: created.id, externalRef: 'ext-1', origin: 'discovery-v1',
        fingerprint: 'fp-1', observed: OBSERVED_FIXTURE('t'), at: FIXED_NOW + 1000,
      });
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.body.id, testCaseId: created.id, externalRef: 'ext-1', origin: 'discovery-v1',
        fingerprint: 'fp-2', observed: OBSERVED_FIXTURE('t'), at: FIXED_NOW + 2000,
      });

      const page1 = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/observations?limit=1`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const page1Body = await page1.json<any>();
      expect(page1Body.items).toHaveLength(1);
      expect(page1Body.has_more).toBe(true);
      expect(page1Body.total).toBe(2);
      expect(page1Body.items[0].fingerprint).toBe('fp-2'); // 新しい観測が先頭(created_at DESC)

      const page2 = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/observations?limit=1&cursor=${encodeURIComponent(page1Body.next_cursor)}`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      const page2Body = await page2.json<any>();
      expect(page2Body.items).toHaveLength(1);
      expect(page2Body.items[0].fingerprint).toBe('fp-1');
      expect(page2Body.has_more).toBe(false);
    });

    it('存在しない :id → 404', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/00000000-0000-0000-0000-000000000000/observations`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/projects/:pid/testcases/:id/identities(apis/testcases.md)', () => {
    it('{items:[{id,origin,external_ref,is_stale,last_seen_at,created_at}]}', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.body.id, testCaseId: created.id, externalRef: 'ext-1', origin: 'discovery-v1',
        fingerprint: 'fp1', observed: OBSERVED_FIXTURE('t'), at: FIXED_NOW + 1000,
      });

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/identities`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toEqual({
        id: expect.any(String),
        origin: 'discovery-v1',
        external_ref: 'ext-1',
        is_stale: false,
        last_seen_at: FIXED_NOW + 1000,
        created_at: FIXED_NOW + 1000,
      });
    });

    it('存在しない :id → 404', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/00000000-0000-0000-0000-000000000000/identities`,
        { headers: { Cookie: cookieHeader(admin.jar) } },
      );
      expect(res.status).toBe(404);
    });

    it('Bearer トークン: 200(自 project の参照系 GET は到達可能)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'payment-service');
      const created = await postTestCase(ctx.app, admin, project.body.id);
      const plaintext = await issueToken(ctx.app, admin, project.body.id, 'discovery-ci');

      const res = await ctx.app.request(
        `/api/v1/projects/${project.body.id}/testcases/${created.id}/identities`,
        { headers: { Authorization: `Bearer ${plaintext}` } },
      );
      expect(res.status).toBe(200);
    });
  });
});
