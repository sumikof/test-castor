// tests/integration/ui-testcase-detail.test.ts
// task-20-brief.md「テストケース作成/詳細/編集 + タブ(S-09〜S-14)」SSR スモークテスト。
// docs/screens/testcase/S-09-testcase-create.md 〜 S-14-change-history.md(6ファイル)・
// docs/data-model.md「状態遷移の許可マトリクス」・スペック D-13-3/4 と1:1対応させる(GC-1)。
// tests/integration/ui-testcase-list.test.ts / helpers-seed.ts と同じハーネス(実 D1 + 固定クロック)を使う。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  makeTestApp, wipe, cookieHeader, setupAndLogin, loginAs, createProject, issueToken, FIXED_NOW, type TestApp,
} from './helpers';
import { seedCommittedObservation } from './helpers-seed';
import { renderGherkin } from '../../src/domain/gherkin';

// --- ローカルテストユーティリティ(ui-testcase-list.test.ts と同じ規約でファイルごとに複製する) ---

function formReq(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  };
}

/** 同一キー複数値(param_name[]・param_inputs[]・param_expected[]・tags[])を持てるフォーム送信用。 */
function multiFormReq(pairs: Array<[string, string]>, headers: Record<string, string> = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of pairs) sp.append(k, v);
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: sp.toString(),
  };
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
function countTag(html: string, testid: string): number {
  const re = new RegExp(`data-testid="${testid}"`, 'g');
  return (html.match(re) || []).length;
}
function unescapeHtml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function attrValue(tag: string, attr: string): string | null {
  const m = tag.match(new RegExp(`${attr}="([^"]*)"`));
  return m?.[1] !== undefined ? unescapeHtml(m[1]) : null;
}
function tagText(html: string, testid: string): string {
  const openMatch = html.match(new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)[^>]*data-testid="${testid}"[^>]*>`));
  if (!openMatch) throw new Error(`data-testid="${testid}" を持つタグが見つからない\n---\n${html}`);
  const tagName = openMatch[1];
  const startIdx = (openMatch.index ?? 0) + openMatch[0].length;
  const endIdx = html.indexOf(`</${tagName}>`, startIdx);
  if (endIdx === -1) throw new Error(`data-testid="${testid}" の終了タグ </${tagName}> が見つからない`);
  return html.slice(startIdx, endIdx);
}

/** editor+ の select-status は `<option>` 群がタグ内容になる(viewer の読み取り専用表示は素のテキスト)。
 * `<option value="X" selected...>` から選択中の値を取り出す。 */
function selectedOptionValue(html: string, testid: string): string | null {
  const inner = tagText(html, testid);
  const m = inner.match(/<option value="([^"]*)" selected/);
  return m?.[1] ?? null;
}

/** 複数件の data-testid が同一プレフィックスを共有する場合(例: identity-row-{uuid})の出現数。 */
function countTagPrefix(html: string, prefix: string): number {
  const re = new RegExp(`data-testid="${prefix}[^"]*"`, 'g');
  return (html.match(re) || []).length;
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
    headers: { 'content-type': 'application/json', Cookie: cookieHeader(adminCtx.jar), 'x-csrf-token': adminCtx.csrf ?? '' },
    body: JSON.stringify({ email, password, display_name: `${role} One`, role }),
  });
  if (res.status !== 201) throw new Error(`${role}作成に失敗: ${res.status} ${await res.text()}`);
  return loginAs(ctx.app, email, password);
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const BASE_FIELDS = {
  title: '有効期限切れカードで決済を試みるとエラーが返る',
  target: 'com.example.PaymentService#charge',
  category: 'abnormal',
  given: '有効期限が過去のカード情報が登録されている',
  when: 'そのカードで 1,000 円の決済を実行する',
  then: '決済が拒否され、エラーコード CARD_EXPIRED が返る',
};

/** S-09 作成フォームを POST し、303 リダイレクト先(S-10 詳細 URL)から新規 id を取り出す。 */
async function createViaForm(
  ctx: TestApp,
  editor: { jar: Record<string, string>; csrf?: string },
  pid: string,
  fields: Record<string, string> = {},
  pairs: Array<[string, string]> = [],
): Promise<{ res: Response; id: string }> {
  const all: Record<string, string> = { ...BASE_FIELDS, ...fields, _csrf: editor.csrf ?? '' };
  const res = await ctx.app.request(
    `/projects/${pid}/testcases`,
    pairs.length > 0
      ? multiFormReq([...Object.entries(all), ...pairs], { Cookie: cookieHeader(editor.jar) })
      : formReq(all, { Cookie: cookieHeader(editor.jar) }),
  );
  expect(res.status).toBe(303);
  const loc = new URL(res.headers.get('location') as string, 'http://x');
  expect(loc.searchParams.get('flash')).toBe('testcase_created');
  const id = loc.pathname.split('/').pop() as string;
  return { res, id };
}

async function getDetail(ctx: TestApp, jar: Record<string, string>, pid: string, id: string, query = '') {
  const res = await ctx.app.request(`/projects/${pid}/testcases/${id}${query}`, { headers: { Cookie: cookieHeader(jar) } });
  return { res, html: await res.text() };
}

async function getTab(ctx: TestApp, jar: Record<string, string>, pid: string, id: string, tab: string, query = '') {
  const res = await ctx.app.request(
    `/projects/${pid}/testcases/${id}/tabs/${tab}${query}`,
    { headers: { Cookie: cookieHeader(jar), 'HX-Request': 'true' } },
  );
  return { res, html: await res.text() };
}

/** OCC 用の hidden version を取得(edit フォーム GET から)。 */
async function getEditVersion(ctx: TestApp, jar: Record<string, string>, pid: string, id: string): Promise<number> {
  const res = await ctx.app.request(`/projects/${pid}/testcases/${id}/edit?confirmed=1`, { headers: { Cookie: cookieHeader(jar) } });
  const html = await res.text();
  const m = html.match(/name="version" value="(\d+)"/);
  if (!m) throw new Error(`version hidden field が見つからない\n---\n${html}`);
  return Number(m[1]);
}

describe('SSR: テストケース作成/詳細/編集 + タブ(S-09〜S-14)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec);
  });

  // ==========================================================================
  // S-09 テストケース作成
  // ==========================================================================
  describe('S-09 テストケース作成', () => {
    it('GET /projects/:pid/testcases/new: 主要フィールド・ボタンの testid が揃う(作成ボタンのみ・D-13-3)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'payment-service');
      const res = await ctx.app.request(`/projects/${project.id}/testcases/new`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();

      for (const testid of [
        'input-title', 'input-target', 'hint-target', 'select-category',
        'textarea-given', 'textarea-when', 'textarea-then',
        'section-parameters', 'btn-param-add', 'section-metadata', 'input-tags', 'btn-tag-add',
        'btn-cancel', 'btn-create',
      ]) {
        expect(hasTag(html, testid)).toBe(true);
      }
      // D-13-3: 「作成」1ボタンに統合。下書き保存ボタンは描画しない。
      expect(hasTag(html, 'btn-save-draft')).toBe(false);
      // 初期表示: パラメータ行なし。
      expect(hasTag(html, 'param-row-0')).toBe(false);
      expect(attrValue(findTag(html, 'select-category'), 'data-testid')).toBe('select-category');
    });

    it('POST 作成 → 303 で S-10 へ。全フィールド(パラメータ・タグ含む)が詳細画面に反映される', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'payment-service');

      const { id } = await createViaForm(ctx, admin, project.id, {}, [
        ['param_name[]', '期限切れ'], ['param_inputs[]', '{"card_expiry":"2020-01"}'], ['param_expected[]', 'CARD_EXPIRED'],
        ['tags[]', 'payment'], ['tags[]', 'card-validation'],
      ]);

      const { res, html } = await getDetail(ctx, admin.jar, project.id, id, '?flash=testcase_created');
      expect(res.status).toBe(200);
      expect(tagText(html, 'toast')).toBe('テストケースを作成しました');
      expect(tagText(html, 'testcase-title')).toBe(BASE_FIELDS.title);
      expect(tagText(html, 'display-target')).toBe(BASE_FIELDS.target);
      expect(tagText(html, 'display-category')).toBe('異常系');
      expect(tagText(html, 'display-given')).toBe(BASE_FIELDS.given);
      expect(tagText(html, 'display-when')).toBe(BASE_FIELDS.when);
      expect(tagText(html, 'display-then')).toBe(BASE_FIELDS.then);
      expect(html).toContain('期限切れ');
      expect(html).toContain('CARD_EXPIRED');
      expect(hasTag(html, 'display-tag-payment')).toBe(true);
      expect(hasTag(html, 'display-tag-card-validation')).toBe(true);
      expect(tagText(html, 'display-origin')).toBe('manual');
      expect(selectedOptionValue(html, 'select-status')).toBe('draft');
      expect(tagText(html, 'display-ownership')).toContain('human');
      // draft は編集/アーカイブが出て復帰は出ない。
      expect(hasTag(html, 'btn-edit')).toBe(true);
      expect(hasTag(html, 'btn-archive')).toBe(true);
      expect(hasTag(html, 'btn-restore')).toBe(false);
    });

    it('バリデーションエラー: 必須フィールド空 → 200 で再描画 + error-title 等にメッセージ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'validation-svc');
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases`,
        formReq({ title: '', target: '', category: 'normal', given: '', when: '', then: '', _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'error-title')).not.toBe('');
      expect(tagText(html, 'error-given')).not.toBe('');
      expect(tagText(html, 'error-when')).not.toBe('');
      expect(tagText(html, 'error-then')).not.toBe('');
    });

    it('パラメータ行の inputs が不正な JSON → 該当行のエラーのみ表示', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'bad-json-svc');
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases`,
        multiFormReq([
          ...Object.entries(BASE_FIELDS), ['_csrf', admin.csrf ?? ''],
          ['param_name[]', 'x'], ['param_inputs[]', '{not valid json'], ['param_expected[]', 'エラー'],
        ], { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(tagText(html, 'error-param-inputs-0')).toContain('JSON');
      expect(tagText(html, 'error-title')).toBe('');
    });

    it('viewer は 403(作成できない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'viewer-create-svc');
      const viewer = await createUserAndLogin(ctx, admin, 'viewer-create@example.com', 'viewer');
      const res = await ctx.app.request(`/projects/${project.id}/testcases/new`, { headers: { Cookie: cookieHeader(viewer.jar) } });
      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  // S-10 詳細 + S-11 編集
  // ==========================================================================
  describe('S-10 詳細 + S-11 編集', () => {
    it('human 所有: 編集ボタンは machine 警告なしで直接フォーム(edit-input-title 等)を表示', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'human-edit-svc');
      const { id } = await createViaForm(ctx, admin, project.id);

      const res = await ctx.app.request(`/projects/${project.id}/testcases/${id}/edit`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(hasTag(html, 'dialog-machine-warning')).toBe(false);
      expect(attrValue(findTag(html, 'edit-input-title'), 'value')).toBe(BASE_FIELDS.title);
      expect(hasTag(html, 'edit-display-version')).toBe(true);
      expect(hasTag(html, 'edit-btn-save')).toBe(true);
    });

    it('machine 所有: 編集ボタンは machine-warning-text を含む警告ダイアログを表示し、?confirmed=1 でフォームに進む', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'machine-edit-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      await ctx.rawExec(`UPDATE test_cases SET ownership = 'machine', mirror_origin = 'discovery-v1' WHERE id = ${sqlStr(id)}`);

      const gate = await ctx.app.request(`/projects/${project.id}/testcases/${id}/edit`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(gate.status).toBe(200);
      const gateHtml = await gate.text();
      expect(hasTag(gateHtml, 'dialog-machine-warning')).toBe(true);
      expect(tagText(gateHtml, 'machine-warning-text')).toContain('Discovery');
      expect(hasTag(gateHtml, 'machine-warning-btn-cancel')).toBe(true);
      expect(hasTag(gateHtml, 'machine-warning-btn-continue')).toBe(true);
      expect(hasTag(gateHtml, 'edit-input-title')).toBe(false);

      const continueHref = attrValue(findTag(gateHtml, 'machine-warning-btn-continue'), 'href') as string;
      const confirmed = await ctx.app.request(continueHref, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(confirmed.status).toBe(200);
      const confirmedHtml = await confirmed.text();
      expect(hasTag(confirmedHtml, 'dialog-machine-warning')).toBe(false);
      expect(hasTag(confirmedHtml, 'edit-input-title')).toBe(true);
    });

    it('編集保存(machine行・内容変更あり)→ human化 + version+1 + 履歴タブに actor_display 付き updated が現れる', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'edit-save-svc');
      const editor = await createUserAndLogin(ctx, admin, 'editor-save@example.com', 'editor');
      const { id } = await createViaForm(ctx, admin, project.id);
      await ctx.rawExec(`UPDATE test_cases SET ownership = 'machine', mirror_origin = 'discovery-v1' WHERE id = ${sqlStr(id)}`);
      // 固定クロックのままだと created と updated の history 行が同一 created_at になり、newest-first の
      // タイブレーク(id DESC)が UUID 次第で不定になる。時計を進めて確定的な新しい順にする。
      ctx.advance(1000);

      const version = await getEditVersion(ctx, editor.jar, project.id, id);
      const newThen = '決済が拒否され、エラーコード CARD_EXPIRED_V2 が返る';
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/edit`,
        formReq(
          { ...BASE_FIELDS, then: newThen, version: String(version), _csrf: editor.csrf ?? '' },
          { Cookie: cookieHeader(editor.jar) },
        ),
      );
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get('location') as string, 'http://x');
      expect(loc.searchParams.get('flash')).toBe('testcase_ownership_transitioned');

      const { html } = await getDetail(ctx, editor.jar, project.id, id);
      expect(tagText(html, 'display-then')).toBe(newThen);
      expect(tagText(html, 'display-ownership')).toContain('human');
      expect(tagText(html, 'display-version')).toBe('バージョン: 2');

      const { html: historyHtml } = await getTab(ctx, editor.jar, project.id, id, 'history');
      // created(手動作成)+ updated(今回の編集)の2件。newest-first なので先頭が updated。
      expect(countTag(historyHtml, 'history-entry')).toBe(2);
      expect(tagText(historyHtml, 'history-action')).toBe('更新');
      expect(tagText(historyHtml, 'history-actor')).toBe('editor One');
      expect(historyHtml).toContain(newThen);
    });

    // review round 1 #2(Important): create ルートは createTestCaseInput.safeParse で
    // parameters/metadata の byte 上限(LIMITS.parametersBytes/metadataBytes)を強制するが、
    // 編集保存ルートは validateTestCaseForm(JS文字列長のみ)しか通さず zod の byte 上限検証を
    // 一切行っていなかった(修正前はこのテストが FAIL する: 保存されて 303 になる)。
    it('編集保存: metadata が byte 上限(10KB)を超える → 保存されず 200 で再描画される(review round 1 #2)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'edit-bytecap-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const version = await getEditVersion(ctx, admin.jar, project.id, id);

      // 単一の巨大タグで metadata の JSON 化後サイズが LIMITS.metadataBytes(10KB)を超える値を作る。
      const hugeTag = 'x'.repeat(12_000);
      const attemptedThen = '巨大メタデータでの上書き試行(保存されてはいけない)';
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/edit`,
        multiFormReq(
          [
            ...Object.entries({ ...BASE_FIELDS, then: attemptedThen, version: String(version), _csrf: admin.csrf ?? '' }),
            ['tags[]', hugeTag],
          ],
          { Cookie: cookieHeader(admin.jar) },
        ),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(hasTag(html, 'edit-form-error')).toBe(true);

      const { html: detailHtml } = await getDetail(ctx, admin.jar, project.id, id);
      expect(tagText(detailHtml, 'display-then')).toBe(BASE_FIELDS.then);
      expect(tagText(detailHtml, 'display-version')).toBe('バージョン: 1');
    });

    // B5(HANDOVER §4.2): metadata(10KB)と同一コードパス(patchTestCaseInput.safeParse)だが、
    // parameters(100KB)専用の回帰テストが無かった穴を塞ぐ。境界の対照(上限内は保存成功)も置き、
    // 「上限値が判定要因である」ことを識別的に証明する。
    it('編集保存: parameters が byte 上限(100KB)を超える → 保存されず 200 で再描画(B5)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'edit-param-cap-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const version = await getEditVersion(ctx, admin.jar, project.id, id);

      // JSON.stringify(parameters) が 100*1024 bytes を超える巨大 inputs(JSON テキストとしては正当)
      const hugeInputs = JSON.stringify({ big: 'x'.repeat(105 * 1024) });
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/edit`,
        multiFormReq(
          [
            ...Object.entries({ ...BASE_FIELDS, version: String(version), _csrf: admin.csrf ?? '' }),
            ['param_name[]', 'huge'], ['param_inputs[]', hugeInputs], ['param_expected[]', 'ok'],
          ],
          { Cookie: cookieHeader(admin.jar) },
        ),
      );
      expect(res.status).toBe(200);
      expect(hasTag(await res.text(), 'edit-form-error')).toBe(true);

      const { html: detailHtml } = await getDetail(ctx, admin.jar, project.id, id);
      expect(tagText(detailHtml, 'display-version')).toBe('バージョン: 1'); // 保存されていない(識別)
    });

    it('編集保存: parameters が上限内(~90KB)なら保存される(B5 境界の対照)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'edit-param-ok-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const version = await getEditVersion(ctx, admin.jar, project.id, id);

      const okInputs = JSON.stringify({ big: 'x'.repeat(90 * 1024) }); // ~92KB < 100KB
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/edit`,
        multiFormReq(
          [
            ...Object.entries({ ...BASE_FIELDS, version: String(version), _csrf: admin.csrf ?? '' }),
            ['param_name[]', 'large-ok'], ['param_inputs[]', okInputs], ['param_expected[]', 'ok'],
          ],
          { Cookie: cookieHeader(admin.jar) },
        ),
      );
      expect(res.status).toBe(303); // 保存成功

      const { html: detailHtml } = await getDetail(ctx, admin.jar, project.id, id);
      expect(tagText(detailHtml, 'display-version')).toBe('バージョン: 2'); // version が進む(識別)
    });

    it('古い version で保存 → 200 で occ-conflict-banner + btn-reload-latest を表示。保存内容は反映されない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'occ-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      // 別ユーザーの並行更新をシミュレート(version=2・title を書き換え済み)。
      await ctx.rawExec(`UPDATE test_cases SET version = 2, title = '並行更新後のタイトル' WHERE id = ${sqlStr(id)}`);

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/edit`,
        formReq(
          { ...BASE_FIELDS, title: '古いバージョンからの上書き試行', version: '1', _csrf: admin.csrf ?? '' },
          { Cookie: cookieHeader(admin.jar) },
        ),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(hasTag(html, 'occ-conflict-banner')).toBe(true);
      expect(hasTag(html, 'btn-reload-latest')).toBe(true);

      // review round 1 #3(Important・human 所有行側の回帰確認): human 所有行では元々 machine 警告
      // ゲートが無いため、再読み込みリンクに confirmed=1 は付かない。実際にたどっても編集フォームへ
      // 直接戻ることを確認する(この部分は修正前後どちらでも成立するはずの現状維持アサーション)。
      const reloadHref = attrValue(findTag(html, 'btn-reload-latest'), 'href') as string;
      expect(reloadHref).not.toContain('confirmed=1');
      const followed = await ctx.app.request(reloadHref, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(followed.status).toBe(200);
      const followedHtml = await followed.text();
      expect(hasTag(followedHtml, 'edit-input-title')).toBe(true);

      const { html: detailHtml } = await getDetail(ctx, admin.jar, project.id, id);
      expect(tagText(detailHtml, 'testcase-title')).toBe('並行更新後のタイトル');
      expect(detailHtml).not.toContain('古いバージョンからの上書き試行');
    });

    // review round 1 #3(Important): TestCaseEditForm の btn-reload-latest href は edit action を
    // そのまま再利用しており、machine 所有行の OCC 競合時にも confirmed=1 を持たない。そのためリンクを
    // たどると GET /edit が machine 警告ダイアログを再表示してしまい、S-11 画面遷移表
    // 「OCC 競合 → 再読み込み | S-11 編集モード(最新データで再描画)」に反する(修正前はこのテストが
    // FAIL する: href に confirmed=1 が含まれず、機械警告ダイアログを経由してしまう)。
    it('OCC 競合(machine 所有行): btn-reload-latest が confirmed=1 を含み、machine 警告を経由せず編集フォームへ直接戻る(review round 1 #3)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'occ-machine-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      await ctx.rawExec(`UPDATE test_cases SET ownership = 'machine', mirror_origin = 'discovery-v1' WHERE id = ${sqlStr(id)}`);
      // 別の書き込み(Discovery 側の同期等)が先に version だけを進めた状態をシミュレート(ownership は machine のまま)。
      await ctx.rawExec(`UPDATE test_cases SET version = 2 WHERE id = ${sqlStr(id)}`);

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/edit`,
        formReq(
          { ...BASE_FIELDS, then: '機械所有行のOCC再現用の上書き試行', version: '1', _csrf: admin.csrf ?? '' },
          { Cookie: cookieHeader(admin.jar) },
        ),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(hasTag(html, 'occ-conflict-banner')).toBe(true);
      const reloadHref = attrValue(findTag(html, 'btn-reload-latest'), 'href') as string;
      expect(reloadHref).toContain('confirmed=1');

      const followed = await ctx.app.request(reloadHref, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(followed.status).toBe(200);
      const followedHtml = await followed.text();
      expect(hasTag(followedHtml, 'dialog-machine-warning')).toBe(false);
      expect(hasTag(followedHtml, 'edit-input-title')).toBe(true);
    });

    it('draft→approved: ステータス確認ダイアログ→実行で成功し flash「テストケースを承認しました」', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'status-approve-svc');
      const { id } = await createViaForm(ctx, admin, project.id);

      const confirm = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/status-confirm?to=approved`,
        { headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' } },
      );
      expect(confirm.status).toBe(200);
      const confirmHtml = await confirm.text();
      expect(hasTag(confirmHtml, 'dialog-confirm-approve')).toBe(true);
      expect(confirmHtml).toContain('このテストケースを承認しますか？');

      const versionMatch = confirmHtml.match(/name="version" value="(\d+)"/);
      const formVersion = versionMatch?.[1] ?? '1';

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/status`,
        formReq({ to: 'approved', version: formVersion, _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get('location') as string, 'http://x');
      expect(loc.searchParams.get('flash')).toBe('testcase_status_approved');

      const { html } = await getDetail(ctx, admin.jar, project.id, id, '?flash=testcase_status_approved');
      expect(tagText(html, 'toast')).toBe('テストケースを承認しました');
      expect(selectedOptionValue(html, 'select-status')).toBe('approved');
    });

    it('古い version で status POST → 303 + flash=occ_conflict、状態は変わらない(B4)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'status-occ-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      // 並行更新をシミュレート(version=2 へ)。POST は古い version=1 を送る。
      await ctx.rawExec(`UPDATE test_cases SET version = 2 WHERE id = ${sqlStr(id)}`);

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/status`,
        formReq({ to: 'approved', version: '1', _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get('location') as string, 'http://x');
      expect(loc.searchParams.get('flash')).toBe('occ_conflict');

      // 識別: ステータスは draft のまま(承認は反映されていない)
      const { html } = await getDetail(ctx, admin.jar, project.id, id);
      expect(selectedOptionValue(html, 'select-status')).toBe('draft');
    });

    it('archived: 復帰ボタンのみ表示・approved へのタンパリング POST は拒否される(状態不変)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'archived-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      await ctx.rawExec(`UPDATE test_cases SET status = 'archived', version = 1 WHERE id = ${sqlStr(id)}`);

      const { html } = await getDetail(ctx, admin.jar, project.id, id);
      expect(hasTag(html, 'btn-restore')).toBe(true);
      expect(hasTag(html, 'btn-archive')).toBe(false);
      expect(hasTag(html, 'btn-edit')).toBe(false);
      // select-status の選択肢に approved が無い(draft のみ + 自身の archived)。
      const selectTag = findTag(html, 'select-status');
      const selectBody = tagText(html, 'select-status');
      expect(selectTag).toContain('<select');
      expect(selectBody).not.toContain('value="approved"');
      expect(selectBody).toContain('value="draft"');

      // 直接 URL 操作で status-confirm?to=approved を叩いてもダイアログは開かない(303 で detail へ)。
      const tamperConfirm = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/status-confirm?to=approved`,
        { headers: { Cookie: cookieHeader(admin.jar) }, redirect: 'manual' },
      );
      expect(tamperConfirm.status).toBe(303);

      // POST /status への直接タンパリングも許可マトリクス違反として拒否される。
      const tamperPost = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/status`,
        formReq({ to: 'approved', version: '1', _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(tamperPost.status).toBe(303);
      const loc = new URL(tamperPost.headers.get('location') as string, 'http://x');
      expect(loc.searchParams.get('flash')).toBe('testcase_status_invalid');

      const { html: after } = await getDetail(ctx, admin.jar, project.id, id);
      expect(selectedOptionValue(after, 'select-status')).toBe('archived');
    });

    it('status=approved も draft と同様に編集・アーカイブボタンを表示し復帰ボタンは出さない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'approved-buttons-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      await ctx.rawExec(`UPDATE test_cases SET status = 'approved' WHERE id = ${sqlStr(id)}`);

      const { html } = await getDetail(ctx, admin.jar, project.id, id);
      expect(hasTag(html, 'btn-edit')).toBe(true);
      expect(hasTag(html, 'btn-archive')).toBe(true);
      expect(hasTag(html, 'btn-restore')).toBe(false);
      // approved からの選択肢は draft(差し戻し)/archived のみ。
      const selectBody = tagText(html, 'select-status');
      expect(selectBody).toContain('value="draft"');
      expect(selectBody).toContain('value="archived"');
    });

    it('badge-stale はヘッダーにも is_stale=true のときだけ表示される(非ゼロ判別)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'header-stale-svc');
      const { id: staleId } = await createViaForm(ctx, admin, project.id, { title: 'stale なケース' });
      await ctx.rawExec(`UPDATE test_cases SET is_stale = 1, mirror_origin = 'discovery-v3' WHERE id = ${sqlStr(staleId)}`);
      const { id: freshId } = await createViaForm(ctx, admin, project.id, { title: 'stale でないケース' });

      const { html: staleHtml } = await getDetail(ctx, admin.jar, project.id, staleId);
      expect(hasTag(staleHtml, 'badge-stale')).toBe(true);
      expect(tagText(staleHtml, 'badge-stale')).toContain('discovery-v3');

      const { html: freshHtml } = await getDetail(ctx, admin.jar, project.id, freshId);
      expect(hasTag(freshHtml, 'badge-stale')).toBe(false);
    });

    it('viewer: ステータスは読み取り専用テキスト。編集・アーカイブ・復帰ボタンは非表示', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'viewer-detail-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const viewer = await createUserAndLogin(ctx, admin, 'viewer-detail@example.com', 'viewer');

      const { html } = await getDetail(ctx, viewer.jar, project.id, id);
      expect(tagText(html, 'select-status')).toBe('draft');
      expect(findTag(html, 'select-status')).not.toContain('<select');
      expect(hasTag(html, 'btn-edit')).toBe(false);
      expect(hasTag(html, 'btn-archive')).toBe(false);
      expect(hasTag(html, 'btn-restore')).toBe(false);

      const editRes = await ctx.app.request(`/projects/${project.id}/testcases/${id}/edit`, { headers: { Cookie: cookieHeader(viewer.jar) } });
      expect(editRes.status).toBe(403);
    });

    it('テストケース未存在 → 404 + 「テストケースが見つかりません」', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'notfound-svc');
      const res = await ctx.app.request(`/projects/${project.id}/testcases/does-not-exist`, { headers: { Cookie: cookieHeader(admin.jar) } });
      expect(res.status).toBe(404);
      expect(tagText(await res.text(), 'page-404-title')).toBe('テストケースが見つかりません');
    });

    it('タブバー: 5タブ全て表示され、hx-push-url を持つ', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'tabbar-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const { html } = await getDetail(ctx, admin.jar, project.id, id);
      for (const testid of ['tab-basic-info', 'tab-gherkin', 'tab-diff', 'tab-history', 'tab-identities']) {
        expect(hasTag(html, testid)).toBe(true);
        expect(attrValue(findTag(html, testid), 'hx-push-url')).not.toBeNull();
      }
      expect(hasTag(html, 'breadcrumb')).toBe(true);
    });
  });

  // ==========================================================================
  // S-12 構造化Diff タブ
  // ==========================================================================
  describe('S-12 構造化Diff タブ', () => {
    it('drift あり(given/then の2フィールド変更): 2件分の diff-line-removed/added、when/parametersは変更なし', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'diff-drift-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      await ctx.rawExec(
        `UPDATE test_cases SET ownership = 'machine', mirror_origin = 'discovery-v1', drift = 1, fingerprint = 'old-fp' WHERE id = ${sqlStr(id)}`,
      );
      const newGiven = '有効期限が過去のカード情報が複数登録されている';
      const newThen = '決済が拒否され、エラーコード CARD_EXPIRED_NEW が返る';
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.id, testCaseId: id, externalRef: 'ext-1', origin: 'discovery-v1', fingerprint: 'new-fp',
        observed: { given: newGiven, when: BASE_FIELDS.when, then: newThen, parameters: null, source_ref: {}, schema_version: '1.0' },
        at: FIXED_NOW + 1000,
      });

      const { html } = await getTab(ctx, admin.jar, project.id, id, 'diff');
      expect(hasTag(html, 'diff-header')).toBe(true);
      expect(tagText(html, 'diff-origin')).toBe('discovery-v1');
      expect(hasTag(html, 'diff-section-given')).toBe(true);
      expect(hasTag(html, 'diff-section-when')).toBe(true);
      expect(hasTag(html, 'diff-section-then')).toBe(true);
      expect(hasTag(html, 'diff-section-parameters')).toBe(true);
      // 非ゼロ・判別テスト: 変更フィールド数(2)ぶんの追加/削除行、変更なしフィールド数(2)ぶんの no-change。
      expect(countTag(html, 'diff-line-removed')).toBe(2);
      expect(countTag(html, 'diff-line-added')).toBe(2);
      expect(countTag(html, 'diff-no-change')).toBe(2);
      expect(html).toContain(BASE_FIELDS.given);
      expect(html).toContain(newGiven);
      expect(html).toContain(BASE_FIELDS.then);
      expect(html).toContain(newThen);
      expect(hasTag(html, 'btn-accept-fingerprint')).toBe(true);
    });

    it('drift なし(D-13-4): 「現在 drift は発生していません。canonical のみ表示します。」+ canonical-* を表示', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'diff-nodrift-svc');
      const { id } = await createViaForm(ctx, admin, project.id);

      const { res, html } = await getTab(ctx, admin.jar, project.id, id, 'diff');
      expect(res.status).toBe(200);
      expect(tagText(html, 'diff-no-drift')).toBe('現在 drift は発生していません。canonical のみ表示します。');
      expect(tagText(html, 'canonical-given')).toBe(BASE_FIELDS.given);
      expect(tagText(html, 'canonical-when')).toBe(BASE_FIELDS.when);
      expect(tagText(html, 'canonical-then')).toBe(BASE_FIELDS.then);
      expect(hasTag(html, 'diff-header')).toBe(false);
      expect(hasTag(html, 'btn-accept-fingerprint')).toBe(false);
      expect(countTag(html, 'diff-line-removed')).toBe(0);
    });

    it('viewer: Diff タブは閲覧できるが btn-accept-fingerprint は非表示', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'diff-viewer-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      await ctx.rawExec(
        `UPDATE test_cases SET ownership = 'machine', mirror_origin = 'discovery-v1', drift = 1, fingerprint = 'old-fp' WHERE id = ${sqlStr(id)}`,
      );
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.id, testCaseId: id, externalRef: 'ext-1', origin: 'discovery-v1', fingerprint: 'new-fp',
        observed: { given: 'g2', when: BASE_FIELDS.when, then: BASE_FIELDS.then, parameters: null, source_ref: {}, schema_version: '1.0' },
        at: FIXED_NOW + 500,
      });
      const viewer = await createUserAndLogin(ctx, admin, 'viewer-diff@example.com', 'viewer');
      const { html } = await getTab(ctx, viewer.jar, project.id, id, 'diff');
      expect(hasTag(html, 'diff-header')).toBe(true);
      expect(hasTag(html, 'btn-accept-fingerprint')).toBe(false);
    });

    it('accept-fingerprint: 確認ダイアログ→実行で drift 解消(diff タブが no-drift に変わる)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'accept-fp-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      await ctx.rawExec(
        `UPDATE test_cases SET ownership = 'machine', mirror_origin = 'discovery-v1', drift = 1, fingerprint = 'old-fp' WHERE id = ${sqlStr(id)}`,
      );
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.id, testCaseId: id, externalRef: 'ext-1', origin: 'discovery-v1', fingerprint: 'new-fp',
        observed: { given: '新観測 given', when: BASE_FIELDS.when, then: BASE_FIELDS.then, parameters: null, source_ref: {}, schema_version: '1.0' },
        at: FIXED_NOW + 2000,
      });

      const confirm = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/accept-fingerprint-confirm`,
        { headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' } },
      );
      expect(confirm.status).toBe(200);
      const confirmHtml = await confirm.text();
      expect(hasTag(confirmHtml, 'dialog-confirm-accept-fp')).toBe(true);
      expect(confirmHtml).toContain('最新の観測を正として受け入れ、drift を解消しますか？');
      const versionMatch = confirmHtml.match(/name="version" value="(\d+)"/);
      const formVersion = versionMatch?.[1] ?? '1';

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/accept-fingerprint`,
        formReq({ version: formVersion, _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get('location') as string, 'http://x');
      expect(loc.searchParams.get('flash')).toBe('testcase_drift_accepted');
      expect(loc.searchParams.get('tab')).toBe('diff');

      const { html } = await getTab(ctx, admin.jar, project.id, id, 'diff');
      expect(hasTag(html, 'diff-no-drift')).toBe(true);
      const { html: detailHtml } = await getDetail(ctx, admin.jar, project.id, id);
      expect(hasTag(detailHtml, 'badge-drift')).toBe(false);
    });

    it('古い version で accept-fingerprint POST → 303 + tab=diff&flash=occ_conflict、drift は残る(B4)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'acceptfp-occ-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      // drift 状態を作った上で並行更新をシミュレート(version=2)。POST は古い version=1 を送る。
      await ctx.rawExec(
        `UPDATE test_cases SET ownership = 'machine', mirror_origin = 'discovery-v1', drift = 1, fingerprint = 'old-fp', version = 2 WHERE id = ${sqlStr(id)}`,
      );
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.id, testCaseId: id, externalRef: 'ext-occ', origin: 'discovery-v1', fingerprint: 'new-fp',
        observed: { given: '新観測 given', when: BASE_FIELDS.when, then: BASE_FIELDS.then, parameters: null, source_ref: {}, schema_version: '1.0' },
        at: FIXED_NOW + 2000,
      });

      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/accept-fingerprint`,
        formReq({ version: '1', _csrf: admin.csrf ?? '' }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get('location') as string, 'http://x');
      expect(loc.searchParams.get('tab')).toBe('diff');
      expect(loc.searchParams.get('flash')).toBe('occ_conflict');

      // 識別: drift は解消されていない(バッジが残る)
      const { html: detailHtml } = await getDetail(ctx, admin.jar, project.id, id);
      expect(hasTag(detailHtml, 'badge-drift')).toBe(true);
    });

    it('drift なしで accept-fingerprint-confirm → ダイアログを開かず 303 で diff タブへ(NO_DRIFT ガード)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'no-drift-confirm-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/accept-fingerprint-confirm`,
        { headers: { Cookie: cookieHeader(admin.jar) }, redirect: 'manual' },
      );
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toContain('tab=diff');
    });
  });

  // ==========================================================================
  // S-13 Gherkin タブ
  // ==========================================================================
  describe('S-13 Gherkin タブ', () => {
    it('パラメータなし: Feature/Scenario(Outlineでない)/Given/When/Then が整形表示される', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'gherkin-plain-svc');
      const { id } = await createViaForm(ctx, admin, project.id);

      const { html } = await getTab(ctx, admin.jar, project.id, id, 'gherkin');
      expect(hasTag(html, 'gherkin-content')).toBe(true);
      expect(tagText(html, 'gherkin-feature')).toBe(`Feature: ${BASE_FIELDS.target}`);
      expect(hasTag(html, 'gherkin-scenario')).toBe(true);
      expect(hasTag(html, 'gherkin-scenario-outline')).toBe(false);
      expect(tagText(html, 'gherkin-given')).toBe(`    Given ${BASE_FIELDS.given}`);
      expect(tagText(html, 'gherkin-when')).toBe(`    When ${BASE_FIELDS.when}`);
      expect(tagText(html, 'gherkin-then')).toBe(`    Then ${BASE_FIELDS.then}`);
      expect(hasTag(html, 'gherkin-examples')).toBe(false);
      expect(hasTag(html, 'btn-copy-gherkin')).toBe(true);
      // S-13: エクスポートボタンは MVP 除外。
      expect(hasTag(html, 'btn-export-gherkin')).toBe(false);
    });

    it('target 未設定: Feature にタイトルを使用(target なし状態)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'gherkin-no-target-svc');
      const { id } = await createViaForm(ctx, admin, project.id, { target: '' });
      const { html } = await getTab(ctx, admin.jar, project.id, id, 'gherkin');
      expect(tagText(html, 'gherkin-feature')).toBe(`Feature: ${BASE_FIELDS.title}`);
    });

    it('パラメータあり(2件): Scenario Outline + Examples テーブルに両パターンが表示される', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'gherkin-params-svc');
      const { id } = await createViaForm(ctx, admin, project.id, {}, [
        ['param_name[]', '下限境界'], ['param_inputs[]', '{"age":0}'], ['param_expected[]', '成功'],
        ['param_name[]', '上限超過'], ['param_inputs[]', '{"age":151}'], ['param_expected[]', 'エラー'],
      ]);

      const { html } = await getTab(ctx, admin.jar, project.id, id, 'gherkin');
      expect(hasTag(html, 'gherkin-scenario-outline')).toBe(true);
      expect(hasTag(html, 'gherkin-scenario')).toBe(false);
      expect(hasTag(html, 'gherkin-examples')).toBe(true);
      const examplesHtml = tagText(html, 'gherkin-examples');
      expect(examplesHtml).toContain('下限境界');
      expect(examplesHtml).toContain('上限超過');
      expect(examplesHtml).toContain('成功');
    });

    it('data-raw のコピー文は domain/renderGherkin の出力と完全一致する(C3 の乖離ガード)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'gherkin-raw-svc');
      const { id } = await createViaForm(ctx, admin, project.id, {}, [
        ['param_name[]', 'case-a'], ['param_inputs[]', '{"x":1}'], ['param_expected[]', 'ok'],
      ]);
      const { html } = await getTab(ctx, admin.jar, project.id, id, 'gherkin');

      // data-raw 属性値を HTML アンエスケープして JSON.parse し、コピー払い出し文字列そのものを比較する。
      const m = html.match(/data-raw="([^"]*)"/);
      expect(m).not.toBeNull();
      const unescaped = (m as RegExpMatchArray)[1]!
        .replaceAll('&quot;', '"').replaceAll('&#39;', "'")
        .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      const raw = JSON.parse(unescaped) as string;

      const expected = renderGherkin({
        title: BASE_FIELDS.title, target: BASE_FIELDS.target,
        given: BASE_FIELDS.given, when: BASE_FIELDS.when, then: BASE_FIELDS.then,
        parameters: [{ name: 'case-a', inputs: { x: 1 }, expected: 'ok' }],
      });
      expect(raw).toBe(expected);

      // 可視 DOM 側も同じ buildGherkinLines 由来であることをこのテスト内で自己完結的に断定する
      // (コピー文と DOM が同一ソースから出ることの直接確認。パラメータありなので Scenario Outline)。
      expect(hasTag(html, 'gherkin-scenario-outline')).toBe(true);
      expect(tagText(html, 'gherkin-scenario-outline')).toBe(`  Scenario Outline: ${BASE_FIELDS.title}`);
      expect(tagText(html, 'gherkin-feature')).toBe(`Feature: ${BASE_FIELDS.target}`);
    });
  });

  // ==========================================================================
  // S-14 変更履歴タブ
  // ==========================================================================
  describe('S-14 変更履歴タブ', () => {
    it('actor_display(user/token)・newest-first・ページング(もっと見る)が機能する', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'history-svc');
      const editor = await createUserAndLogin(ctx, admin, 'editor-history@example.com', 'editor');
      const { id } = await createViaForm(ctx, admin, project.id);
      // 固定クロックのままだと created/updated/status_changed が同一 created_at になり newest-first の
      // タイブレークが UUID 次第で不定になるため、各操作の間で時計を進めて確定的な時系列にする。
      ctx.advance(1000);

      // 更新(1件目の実履歴): editor が then を編集。
      const v1 = await getEditVersion(ctx, editor.jar, project.id, id);
      await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/edit`,
        formReq({ ...BASE_FIELDS, then: '更新後の期待結果', version: String(v1), _csrf: editor.csrf ?? '' }, { Cookie: cookieHeader(editor.jar) }),
      );
      ctx.advance(1000);
      // ステータス変更(2件目の実履歴・最新): draft→approved。
      const statusVersion = v1 + 1;
      await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/status`,
        formReq({ to: 'approved', version: String(statusVersion), _csrf: editor.csrf ?? '' }, { Cookie: cookieHeader(editor.jar) }),
      );

      // token actor の imported 履歴(最古)を直挿し。issueToken → api_tokens.id をサブクエリで解決する。
      await issueToken(ctx.app, admin, project.id, 'discovery-ci');
      await ctx.rawExec(
        `INSERT INTO test_case_history (id, test_case_id, actor, action, delta, created_at) ` +
          `VALUES (${sqlStr(crypto.randomUUID())}, ${sqlStr(id)}, ` +
          `'token:' || (SELECT id FROM api_tokens WHERE project_id = ${sqlStr(project.id)} AND name = 'discovery-ci' LIMIT 1), ` +
          `'imported', '{}', ${FIXED_NOW - 100000})`,
      );

      // limit=2(1ページ目に status_changed→updated の2件、importedは2ページ目)。
      const page1 = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/tabs/history?limit=2`,
        { headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' } },
      );
      const html1 = await page1.text();
      expect(countTag(html1, 'history-entry')).toBe(2);
      // newest-first: status_changed(承認)が最初。
      const firstEntry = html1.indexOf('data-testid="history-entry"');
      const statusIdx = html1.indexOf('ステータス変更');
      const updatedIdx = html1.indexOf('更新後の期待結果');
      expect(firstEntry).toBeGreaterThanOrEqual(0);
      expect(statusIdx).toBeLessThan(updatedIdx);
      expect(html1).toContain('editor One'); // actor_display(ユーザー表示名。ロールバッジは listHistory 未提供)
      expect(hasTag(html1, 'btn-load-more-history')).toBe(true);

      const nextHref = attrValue(findTag(html1, 'btn-load-more-history'), 'href') as string;
      expect(nextHref).toContain('cursor=');
      const page2 = await ctx.app.request(nextHref, { headers: { Cookie: cookieHeader(admin.jar) } });
      const html2 = await page2.text();
      expect(hasTag(html2, 'history-entry')).toBe(true);
      expect(html2).toContain('token:discovery-ci');
      expect(hasTag(html2, 'history-initial-import')).toBe(true);
      expect(hasTag(html2, 'btn-load-more-history')).toBe(false);
    });

    it('履歴なし相当は無い(created が必ず1件)が、created 単体では history-delta が出ない', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'history-created-only-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const { html } = await getTab(ctx, admin.jar, project.id, id, 'history');
      expect(hasTag(html, 'history-empty')).toBe(false);
      expect(countTag(html, 'history-entry')).toBe(1);
      expect(tagText(html, 'history-action')).toBe('作成');
      expect(hasTag(html, 'history-delta')).toBe(false);
    });
  });

  // ==========================================================================
  // Identity情報タブ
  // ==========================================================================
  describe('Identity情報タブ', () => {
    it('origin + stale(true/false 両方)+ 最終観測日時が表示される(非ゼロ判別)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'identity-svc');
      const { id } = await createViaForm(ctx, admin, project.id);

      await seedCommittedObservation(ctx.rawExec, {
        pid: project.id, testCaseId: id, externalRef: 'ext-active', origin: 'discovery-v1', fingerprint: 'fp-1',
        observed: { given: 'g', when: 'w', then: 't', parameters: null, source_ref: {}, schema_version: '1.0' },
        at: FIXED_NOW - 5000,
      });
      await seedCommittedObservation(ctx.rawExec, {
        pid: project.id, testCaseId: id, externalRef: 'ext-stale', origin: 'discovery-v2', fingerprint: 'fp-2',
        observed: { given: 'g', when: 'w', then: 't', parameters: null, source_ref: {}, schema_version: '1.0' },
        at: FIXED_NOW - 9000,
      });
      await ctx.rawExec(
        `UPDATE test_case_identities SET is_stale = 1 WHERE test_case_id = ${sqlStr(id)} AND origin = 'discovery-v2'`,
      );

      const { html } = await getTab(ctx, admin.jar, project.id, id, 'identities');
      expect(hasTag(html, 'identity-table')).toBe(true);
      expect(countTagPrefix(html, 'identity-row-')).toBe(2);
      expect(html).toContain('discovery-v1');
      expect(html).toContain('discovery-v2');
      expect(html).toContain('ext-active');
      expect(html).toContain('ext-stale');
      // 非ゼロ・判別: stale=true/false の両方が実際に出し分けられている。
      const staleCells = [...html.matchAll(/data-testid="identity-stale-[^"]+">([^<]*)</g)].map((m) => m[1] ?? '');
      expect(staleCells.some((c) => c.includes('🔺'))).toBe(true);
      expect(staleCells.some((c) => c === '—')).toBe(true);
    });

    it('Identity 情報なし → identity-empty', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'identity-empty-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const { html } = await getTab(ctx, admin.jar, project.id, id, 'identities');
      expect(hasTag(html, 'identity-empty')).toBe(true);
      expect(hasTag(html, 'identity-table')).toBe(false);
    });
  });

  // ==========================================================================
  // 横断: CSRF・HTMXフラグメント
  // ==========================================================================
  describe('横断的な確認事項', () => {
    it('CSRF トークン無しの POST /edit は 403(更新されない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'csrf-edit-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const version = await getEditVersion(ctx, admin.jar, project.id, id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}/edit`,
        formReq({ ...BASE_FIELDS, title: '改ざん試行', version: String(version) }, { Cookie: cookieHeader(admin.jar) }),
      );
      expect(res.status).toBe(403);
      const { html } = await getDetail(ctx, admin.jar, project.id, id);
      expect(tagText(html, 'testcase-title')).toBe(BASE_FIELDS.title);
    });

    it('HX-Request での GET 詳細は #tab-panel の中身のみ返す(<html>を含まない)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const { body: project } = await createProject(ctx.app, admin, 'hx-detail-svc');
      const { id } = await createViaForm(ctx, admin, project.id);
      const res = await ctx.app.request(
        `/projects/${project.id}/testcases/${id}`,
        { headers: { Cookie: cookieHeader(admin.jar), 'HX-Request': 'true' } },
      );
      const html = await res.text();
      expect(html).not.toContain('<html');
      expect(hasTag(html, 'testcase-basic-info')).toBe(true);
    });
  });
});
