// tests/integration/sync-commit.test.ts
// task-16-brief.md: commit 8工程パイプライン(工程0〜8)・GET /sync/status の統合テスト。
// docs/sync-protocol.md「Commit 8工程パイプライン」「不変条件とエラーハンドリング」、
// docs/data-model.md(ミラー昇格ガード・drift 条件・rollup TTL・archived の再観測)、スペック D-01 と
// 1:1 で対応させる(GC-1)。実 D1(miniflare binding)+ 固定クロックを使う(tests/integration/helpers.ts)。
//
// GC-1 突合メモ(工程3/4 の参照元置換): sync-protocol.md の工程3/4 は TestCaseObservation を参照する
// SQL 例だが、task-15 ノートのとおり実装は sync_seen(出現台帳)を参照する(chunk が変化点のみ記録する
// ため、観測を参照すると無変化 ref を誤って stale 判定してしまうため)。本ファイルの「無変化再同期」
// テストはまさにこの sync_seen 経路の効果(観測行が増えない ref でも stale にならない)を検証する。
import { describe, it, expect, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import type { AppEnv } from '../../src/http/app';
import { makeTestApp, wipe, cookieHeader, setupAndLogin, createProject, issueToken, FIXED_NOW, type TestApp } from './helpers';

function jsonReq(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
function bearerReq(method: string, token: string, body?: unknown, headers: Record<string, string> = {}) {
  return jsonReq(method, body, { Authorization: `Bearer ${token}`, ...headers });
}
type SessionCtx = { jar: Record<string, string>; csrf?: string };
function sessionReq(method: string, ctx: SessionCtx, body?: unknown, headers: Record<string, string> = {}) {
  return jsonReq(method, body, { Cookie: cookieHeader(ctx.jar), 'x-csrf-token': ctx.csrf ?? '', ...headers });
}

/** observed の固定キーセット(data-model.md)を満たす最小フィクスチャ。GWT はテストごとに上書きする。 */
function obsFixture(overrides: Record<string, unknown> = {}) {
  return { title: 't', given: 'g', when: 'w', then: 'th', parameters: [], source_ref: {}, schema_version: '1.0', ...overrides };
}

function startUrl(pid: string) { return `/api/v1/projects/${pid}/sync/start`; }
function chunkUrl(pid: string, token: string) { return `/api/v1/projects/${pid}/sync/${token}/chunk`; }
function commitUrl(pid: string, token: string) { return `/api/v1/projects/${pid}/sync/${token}/commit`; }
function statusUrl(pid: string) { return `/api/v1/projects/${pid}/sync/status`; }
function tcUrl(pid: string, id?: string) { return `/api/v1/projects/${pid}/testcases${id ? `/${id}` : ''}`; }

async function setupProjectWithToken(app: Hono<AppEnv>, projectName = 'discovery-project', tokenName = 'discovery-sat') {
  const admin = await setupAndLogin(app);
  const project = await createProject(app, admin, projectName);
  const apiToken = await issueToken(app, admin, project.body.id, tokenName);
  return { admin, pid: project.body.id as string, apiToken };
}

async function startSync(app: Hono<AppEnv>, apiToken: string, pid: string, origin: string) {
  const res = await app.request(startUrl(pid), bearerReq('POST', apiToken, { origin }));
  if (res.status !== 201) throw new Error(`startSync failed ${res.status}: ${await res.text()}`);
  return res.json<any>();
}

async function chunkSync(app: Hono<AppEnv>, apiToken: string, pid: string, token: string, observations: unknown[]) {
  const res = await app.request(chunkUrl(pid, token), bearerReq('POST', apiToken, { observations }));
  if (res.status !== 200) throw new Error(`chunkSync failed ${res.status}: ${await res.text()}`);
  return res.json<any>();
}

async function commitOnce(app: Hono<AppEnv>, apiToken: string, pid: string, token: string) {
  const res = await app.request(commitUrl(pid, token), bearerReq('POST', apiToken));
  const body = await res.json<any>();
  return { status: res.status, body };
}

/** more:true の間 commit を叩き続け、最終(200)応答と応答列を返す。 */
async function commitToCompletion(app: Hono<AppEnv>, apiToken: string, pid: string, token: string, maxIterations = 50) {
  const responses: Array<{ status: number; body: any }> = [];
  for (let i = 0; i < maxIterations; i++) {
    const r = await commitOnce(app, apiToken, pid, token);
    responses.push(r);
    if (r.status === 200) return { final: r.body, responses };
    if (r.status !== 202) throw new Error(`commitToCompletion: unexpected status ${r.status}: ${JSON.stringify(r.body)}`);
  }
  throw new Error('commitToCompletion: did not converge within maxIterations');
}

async function getTestCase(app: Hono<AppEnv>, ctx: SessionCtx, pid: string, id: string) {
  const res = await app.request(tcUrl(pid, id), sessionReq('GET', ctx));
  return { status: res.status, body: await res.json<any>() };
}
async function listTestCases(app: Hono<AppEnv>, ctx: SessionCtx, pid: string, query = '') {
  const res = await app.request(`${tcUrl(pid)}?${query}`, sessionReq('GET', ctx));
  return { status: res.status, body: await res.json<any>() };
}
async function getIdentities(app: Hono<AppEnv>, ctx: SessionCtx, pid: string, id: string) {
  const res = await app.request(`${tcUrl(pid, id)}/identities`, sessionReq('GET', ctx));
  return { status: res.status, body: await res.json<any>() };
}
async function getObservations(app: Hono<AppEnv>, ctx: SessionCtx, pid: string, id: string) {
  const res = await app.request(`${tcUrl(pid, id)}/observations`, sessionReq('GET', ctx));
  return { status: res.status, body: await res.json<any>() };
}
async function getHistory(app: Hono<AppEnv>, ctx: SessionCtx, pid: string, id: string) {
  const res = await app.request(`${tcUrl(pid, id)}/history`, sessionReq('GET', ctx));
  return { status: res.status, body: await res.json<any>() };
}
async function getDiff(app: Hono<AppEnv>, ctx: SessionCtx, pid: string, id: string) {
  const res = await app.request(`${tcUrl(pid, id)}/diff`, sessionReq('GET', ctx));
  return { status: res.status, body: await res.json<any>() };
}
async function patchTestCase(app: Hono<AppEnv>, ctx: SessionCtx, pid: string, id: string, version: number, patch: unknown) {
  const res = await app.request(tcUrl(pid, id), sessionReq('PATCH', ctx, patch, { 'if-match': `"${version}"` }));
  return { status: res.status, body: await res.json<any>() };
}
async function archiveTestCase(app: Hono<AppEnv>, ctx: SessionCtx, pid: string, id: string) {
  const res = await app.request(tcUrl(pid, id), sessionReq('DELETE', ctx));
  return { status: res.status, body: await res.json<any>() };
}
async function getStatus(app: Hono<AppEnv>, ctx: SessionCtx, pid: string) {
  const res = await app.request(statusUrl(pid), sessionReq('GET', ctx));
  return { status: res.status, body: await res.json<any>() };
}

describe('統合: commit 8工程パイプライン + GET sync/status(task-16-brief.md)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec);
  });

  it('シナリオ1: ハッピーパス(小規模) — start→chunk(2件)→commit で canonical/identity/history が作られ、GET sync/status に反映される', async () => {
    const { admin, pid, apiToken } = await setupProjectWithToken(ctx.app, 'proj-happy', 'sat-happy');

    const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, started.sync_token, [
      { external_ref: 'ext-happy-1', fingerprint: 'fp-happy-1', observed: obsFixture({ title: 'ケース1' }) },
      { external_ref: 'ext-happy-2', fingerprint: 'fp-happy-2', observed: obsFixture({ title: 'ケース2' }) },
    ]);

    const { final } = await commitToCompletion(ctx.app, apiToken, pid, started.sync_token);
    expect(final.status).toBe('completed');
    expect(final.more).toBe(false);
    expect(final.staled_count).toBe(0);
    expect(final.mappings).toEqual(expect.arrayContaining([
      { external_ref: 'ext-happy-1', test_case_id: expect.any(String), outcome: 'created' },
      { external_ref: 'ext-happy-2', test_case_id: expect.any(String), outcome: 'created' },
    ]));
    expect(final.mappings).toHaveLength(2);

    const idByRef = new Map(final.mappings.map((m: any) => [m.external_ref, m.test_case_id]));
    const id1 = idByRef.get('ext-happy-1') as string;
    const id2 = idByRef.get('ext-happy-2') as string;

    const tc1 = await getTestCase(ctx.app, admin, pid, id1);
    expect(tc1.body.status).toBe('draft');
    expect(tc1.body.ownership).toBe('machine');
    expect(tc1.body.title).toBe('ケース1'); // ミラー済み
    expect(tc1.body.given).toBe('g');
    expect(tc1.body.fingerprint).toBe('fp-happy-1');

    const identities1 = await getIdentities(ctx.app, admin, pid, id1);
    expect(identities1.body.items).toHaveLength(1);
    expect(identities1.body.items[0].origin).toBe('discovery-v1');
    expect(identities1.body.items[0].external_ref).toBe('ext-happy-1');
    expect(identities1.body.items[0].is_stale).toBe(false);

    const history1 = await getHistory(ctx.app, admin, pid, id1);
    expect(history1.body.items.filter((h: any) => h.action === 'imported')).toHaveLength(1);
    expect(history1.body.items.find((h: any) => h.action === 'imported').actor).toMatch(/^token:/);

    const status = await getStatus(ctx.app, admin, pid);
    expect(status.status).toBe(200);
    const origin = status.body.origins.find((o: any) => o.origin === 'discovery-v1');
    expect(origin.last_summary).toEqual({ created: 2, changed: 2, staled: 0 });
    expect(origin.last_committed_at).toBe(FIXED_NOW);
    expect(status.body.current.unreviewed).toBe(2);
    expect(status.body.current.drift).toBe(0);
    expect(status.body.current.stale).toBe(0);
  });

  it('シナリオ2: 無変化再同期 — 同一指紋で再 start→chunk→commit しても観測行数は不変・stale にならない・staled_count=0', async () => {
    const { admin, pid, apiToken } = await setupProjectWithToken(ctx.app, 'proj-nochange', 'sat-nochange');

    const s1 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s1.sync_token, [
      { external_ref: 'ext-nc-1', fingerprint: 'fp-nc-1', observed: obsFixture() },
    ]);
    const { final: final1 } = await commitToCompletion(ctx.app, apiToken, pid, s1.sync_token);
    const id1 = final1.mappings[0].test_case_id as string;

    const obsBefore = await getObservations(ctx.app, admin, pid, id1);
    const countBefore = obsBefore.body.total;

    ctx.advance(1000);
    const s2 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s2.sync_token, [
      { external_ref: 'ext-nc-1', fingerprint: 'fp-nc-1', observed: obsFixture() }, // 同一指紋
    ]);
    const { final: final2 } = await commitToCompletion(ctx.app, apiToken, pid, s2.sync_token);

    expect(final2.staled_count).toBe(0); // sync_seen 経由で再出現が確認され stale 化しない
    expect(final2.mappings).toEqual([{ external_ref: 'ext-nc-1', test_case_id: id1, outcome: 'unchanged' }]);

    const obsAfter = await getObservations(ctx.app, admin, pid, id1);
    expect(obsAfter.body.total).toBe(countBefore); // 観測行数は不変(変化点のみ記録)

    const identities = await getIdentities(ctx.app, admin, pid, id1);
    expect(identities.body.items[0].is_stale).toBe(false);
    const tc = await getTestCase(ctx.app, admin, pid, id1);
    expect(tc.body.is_stale).toBe(false);
  });

  it('シナリオ3: machine 行の変化 — 新指紋で再同期すると canonical 内容/fingerprint が更新される(ミラー)。version は不変(システム列は bump しない)', async () => {
    const { admin, pid, apiToken } = await setupProjectWithToken(ctx.app, 'proj-machine-change', 'sat-machine-change');

    const s1 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s1.sync_token, [
      { external_ref: 'ext-mc-1', fingerprint: 'fp-mc-1', observed: obsFixture({ title: '旧タイトル', given: '旧given' }) },
    ]);
    const { final: final1 } = await commitToCompletion(ctx.app, apiToken, pid, s1.sync_token);
    const id1 = final1.mappings[0].test_case_id as string;
    const before = await getTestCase(ctx.app, admin, pid, id1);
    expect(before.body.version).toBe(1);

    ctx.advance(1000);
    const s2 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s2.sync_token, [
      { external_ref: 'ext-mc-1', fingerprint: 'fp-mc-2', observed: obsFixture({ title: '新タイトル', given: '新given' }) },
    ]);
    const { final: final2 } = await commitToCompletion(ctx.app, apiToken, pid, s2.sync_token);
    expect(final2.mappings).toEqual([{ external_ref: 'ext-mc-1', test_case_id: id1, outcome: 'updated' }]);

    const after = await getTestCase(ctx.app, admin, pid, id1);
    expect(after.body.title).toBe('新タイトル');
    expect(after.body.given).toBe('新given');
    expect(after.body.fingerprint).toBe('fp-mc-2');
    expect(after.body.version).toBe(1); // システム列(fingerprint等)の更新は version を bump しない
    expect(after.body.ownership).toBe('machine');
  });

  it('シナリオ4: human 行の drift — PATCH で human 化した行は再同期しても内容不変・drift=1・GET diff が差分を返す', async () => {
    const { admin, pid, apiToken } = await setupProjectWithToken(ctx.app, 'proj-drift', 'sat-drift');

    const s1 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s1.sync_token, [
      { external_ref: 'ext-drift-1', fingerprint: 'fp-drift-1', observed: obsFixture({ title: '元タイトル', given: '元given' }) },
    ]);
    const { final: final1 } = await commitToCompletion(ctx.app, apiToken, pid, s1.sync_token);
    const id1 = final1.mappings[0].test_case_id as string;

    const beforePatch = await getTestCase(ctx.app, admin, pid, id1);
    const patched = await patchTestCase(ctx.app, admin, pid, id1, beforePatch.body.version, { title: '人間編集後タイトル' });
    expect(patched.status).toBe(200);
    expect(patched.body.ownership).toBe('human'); // 最初の人間編集で machine→human(不可逆)

    ctx.advance(1000);
    const s2 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s2.sync_token, [
      { external_ref: 'ext-drift-1', fingerprint: 'fp-drift-2', observed: obsFixture({ title: '衛星側の新タイトル', given: '衛星側new given' }) },
    ]);
    await commitToCompletion(ctx.app, apiToken, pid, s2.sync_token);

    const after = await getTestCase(ctx.app, admin, pid, id1);
    expect(after.body.title).toBe('人間編集後タイトル'); // human-owned なので import は不可侵
    expect(after.body.given).toBe('元given'); // 内容不変
    expect(after.body.ownership).toBe('human');
    expect(after.body.drift).toBe(true);
    expect(after.body.fingerprint).toBe('fp-drift-1'); // canonical 自体の fingerprint は不変(drift のみ記録)

    const diff = await getDiff(ctx.app, admin, pid, id1);
    expect(diff.body.has_drift).toBe(true);
    expect(diff.body.diff.given).toEqual({ before: '元given', after: '衛星側new given' });
  });

  it('シナリオ5: stale と復帰 — B だけで再同期すると A が stale になり、次に A が再出現すると stale 解除される', async () => {
    const { admin, pid, apiToken } = await setupProjectWithToken(ctx.app, 'proj-stale', 'sat-stale');

    const s1 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s1.sync_token, [
      { external_ref: 'ext-stale-a', fingerprint: 'fp-stale-a', observed: obsFixture() },
      { external_ref: 'ext-stale-b', fingerprint: 'fp-stale-b', observed: obsFixture() },
    ]);
    const { final: final1 } = await commitToCompletion(ctx.app, apiToken, pid, s1.sync_token);
    const idByRef1 = new Map(final1.mappings.map((m: any) => [m.external_ref, m.test_case_id]));
    const idA = idByRef1.get('ext-stale-a') as string;

    ctx.advance(1000);
    const s2 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s2.sync_token, [
      { external_ref: 'ext-stale-b', fingerprint: 'fp-stale-b', observed: obsFixture() }, // A を送らない
    ]);
    const { final: final2 } = await commitToCompletion(ctx.app, apiToken, pid, s2.sync_token);
    expect(final2.staled_count).toBe(1); // A のみ

    const identitiesAfterStale = await getIdentities(ctx.app, admin, pid, idA);
    expect(identitiesAfterStale.body.items[0].is_stale).toBe(true);
    const tcAfterStale = await getTestCase(ctx.app, admin, pid, idA);
    expect(tcAfterStale.body.is_stale).toBe(true);

    ctx.advance(1000);
    const s3 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s3.sync_token, [
      { external_ref: 'ext-stale-a', fingerprint: 'fp-stale-a', observed: obsFixture() }, // A 再出現
      { external_ref: 'ext-stale-b', fingerprint: 'fp-stale-b', observed: obsFixture() },
    ]);
    const { final: final3 } = await commitToCompletion(ctx.app, apiToken, pid, s3.sync_token);
    expect(final3.staled_count).toBe(0);

    const identitiesAfterRecover = await getIdentities(ctx.app, admin, pid, idA);
    expect(identitiesAfterRecover.body.items[0].is_stale).toBe(false);
    const tcAfterRecover = await getTestCase(ctx.app, admin, pid, idA);
    expect(tcAfterRecover.body.is_stale).toBe(false);
  });

  it('シナリオ6: approved 保護 — approved 済みを同期から外しても canonical.is_stale は false のまま(identity は stale になる)', async () => {
    const { admin, pid, apiToken } = await setupProjectWithToken(ctx.app, 'proj-approved', 'sat-approved');

    const s1 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s1.sync_token, [
      { external_ref: 'ext-approved-1', fingerprint: 'fp-approved-1', observed: obsFixture() },
    ]);
    const { final: final1 } = await commitToCompletion(ctx.app, apiToken, pid, s1.sync_token);
    const id1 = final1.mappings[0].test_case_id as string;

    const before = await getTestCase(ctx.app, admin, pid, id1);
    const approved = await patchTestCase(ctx.app, admin, pid, id1, before.body.version, { status: 'approved' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.ownership).toBe('human'); // 承認は最初の接触として machine→human

    ctx.advance(1000);
    // 別の ref だけで再同期(approved 済みの ref を今回セッションから外す)
    const s2 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s2.sync_token, [
      { external_ref: 'ext-approved-other', fingerprint: 'fp-approved-other', observed: obsFixture() },
    ]);
    await commitToCompletion(ctx.app, apiToken, pid, s2.sync_token);

    const identities = await getIdentities(ctx.app, admin, pid, id1);
    expect(identities.body.items[0].is_stale).toBe(true); // identity は普通に stale になる

    const tc = await getTestCase(ctx.app, admin, pid, id1);
    expect(tc.body.is_stale).toBe(false); // canonical は rollup 保護(status NOT IN ('approved','archived'))
    expect(tc.body.status).toBe('approved');
  });

  it('シナリオ7: archived の再観測 — archived を同期に含めても status/内容は不変で観測のみ記録される', async () => {
    const { admin, pid, apiToken } = await setupProjectWithToken(ctx.app, 'proj-archived', 'sat-archived');

    const s1 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s1.sync_token, [
      { external_ref: 'ext-archived-1', fingerprint: 'fp-archived-1', observed: obsFixture({ title: 'archived前タイトル' }) },
    ]);
    const { final: final1 } = await commitToCompletion(ctx.app, apiToken, pid, s1.sync_token);
    const id1 = final1.mappings[0].test_case_id as string;

    const archived = await archiveTestCase(ctx.app, admin, pid, id1);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');

    const obsBefore = await getObservations(ctx.app, admin, pid, id1);
    const countBefore = obsBefore.body.total;

    ctx.advance(1000);
    const s2 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s2.sync_token, [
      { external_ref: 'ext-archived-1', fingerprint: 'fp-archived-2', observed: obsFixture({ title: 'archived後の観測タイトル' }) },
    ]);
    await commitToCompletion(ctx.app, apiToken, pid, s2.sync_token);

    const tc = await getTestCase(ctx.app, admin, pid, id1);
    expect(tc.body.status).toBe('archived'); // 不変
    expect(tc.body.title).toBe('archived前タイトル'); // 内容不変(ミラー対象外)
    expect(tc.body.fingerprint).toBe('fp-archived-1'); // canonical の fingerprint も不変

    const obsAfter = await getObservations(ctx.app, admin, pid, id1);
    expect(obsAfter.body.total).toBe(countBefore + 1); // 新しい指紋のため観測のみ1件追加される
  });

  it('シナリオ8: commit 冪等 — commit を2連打しても同一応答・canonical/history は重複しない', async () => {
    const { admin, pid, apiToken } = await setupProjectWithToken(ctx.app, 'proj-commit-idem', 'sat-commit-idem');

    const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, started.sync_token, [
      { external_ref: 'ext-idem-1', fingerprint: 'fp-idem-1', observed: obsFixture() },
    ]);
    const { final } = await commitToCompletion(ctx.app, apiToken, pid, started.sync_token);
    const id1 = final.mappings[0].test_case_id as string;

    // 既に committed のセッションへ commit を再送 → 200 で保存済み応答(即応)
    const replay = await commitOnce(ctx.app, apiToken, pid, started.sync_token);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(final);

    const historyAfter = await getHistory(ctx.app, admin, pid, id1);
    expect(historyAfter.body.items.filter((h: any) => h.action === 'imported')).toHaveLength(1); // 重複なし

    const listAfter = await listTestCases(ctx.app, admin, pid);
    expect(listAfter.body.items.filter((i: any) => i.id === id1)).toHaveLength(1); // canonical 重複なし
  });

  it(
    'シナリオ9: mid-commit 再開 — windowLimit:1 を注入した deps で commit すると 202/more:true を数回経て最終200になり、' +
      '結果は一括実行(既定 windowLimit)と完全一致する',
    async () => {
      const smallCtx = await makeTestApp({ commitWindowLimit: 1 });
      await wipe(smallCtx.rawExec);
      const { admin, pid: pidSmall, apiToken: tokenSmall } = await setupProjectWithToken(
        smallCtx.app, 'proj-resume-small', 'sat-resume-small',
      );

      const startedSmall = await startSync(smallCtx.app, tokenSmall, pidSmall, 'discovery-v1');
      const observations = [
        { external_ref: 'ext-resume-0', fingerprint: 'fp-resume-0', observed: obsFixture({ title: 'r0' }) },
        { external_ref: 'ext-resume-1', fingerprint: 'fp-resume-1', observed: obsFixture({ title: 'r1' }) },
        { external_ref: 'ext-resume-2', fingerprint: 'fp-resume-2', observed: obsFixture({ title: 'r2' }) },
      ];
      await chunkSync(smallCtx.app, tokenSmall, pidSmall, startedSmall.sync_token, observations);

      const { final: finalSmall, responses } = await commitToCompletion(smallCtx.app, tokenSmall, pidSmall, startedSmall.sync_token, 200);
      expect(responses.length).toBeGreaterThan(1); // windowLimit:1 なら複数回の 202 を経るはず
      expect(responses.slice(0, -1).every((r) => r.status === 202 && r.body.more === true && r.body.status === 'in_progress')).toBe(true);
      expect(finalSmall.status).toBe('completed');
      expect(finalSmall.more).toBe(false);

      // 一括実行(既定 windowLimit=500)で同規模を実行し、結果(mappings の outcome・canonical 内容)が一致することを検証。
      // 注意: env.DB(cloudflare:test)はテストファイル全体で単一の共有 D1 インスタンスのため、
      // makeTestApp() を複数回呼んでも「別々の DB」にはならない(app インスタンス/config は別でも
      // 裏の DB は smallCtx と共有)。そのため (a) wipe() は呼ばない(smallCtx が直前に作った行ごと
      // 消えてしまう)、(b) setupAndLogin(POST /setup)も再度は呼べない(Organization は MVP の
      // 単一固定シングルトンのため2回目は 409 SETUP_ALREADY_COMPLETE になる) — 同じ admin セッション
      // (jar/csrf は DB 上の Session 行に紐づくため、別の app インスタンス(bigCtx.app)への
      // リクエストでも有効)を使い回し、bigCtx.app 経由で新しい project/token だけを発行する
      // (commitWindowLimit だけが違う別の app インスタンスが必要な理由: config は app 構築時に
      // 固定されるため)。
      const bigCtx = await makeTestApp();
      const bigProject = await createProject(bigCtx.app, admin, 'proj-resume-big');
      const pidBig = bigProject.body.id as string;
      const tokenBig = await issueToken(bigCtx.app, admin, pidBig, 'sat-resume-big');
      const startedBig = await startSync(bigCtx.app, tokenBig, pidBig, 'discovery-v1');
      await chunkSync(bigCtx.app, tokenBig, pidBig, startedBig.sync_token, observations);
      const { final: finalBig, responses: responsesBig } = await commitToCompletion(bigCtx.app, tokenBig, pidBig, startedBig.sync_token);
      expect(responsesBig).toHaveLength(1); // 既定の windowLimit なら1回で収束するはず

      expect(finalSmall.staled_count).toBe(finalBig.staled_count);
      const outcomesSmall = finalSmall.mappings.map((m: any) => m.outcome).sort();
      const outcomesBig = finalBig.mappings.map((m: any) => m.outcome).sort();
      expect(outcomesSmall).toEqual(outcomesBig);
      expect(outcomesSmall).toEqual(['created', 'created', 'created']);

      for (const obs of observations) {
        const idSmall = finalSmall.mappings.find((m: any) => m.external_ref === obs.external_ref).test_case_id;
        const idBig = finalBig.mappings.find((m: any) => m.external_ref === obs.external_ref).test_case_id;
        const tcSmall = await getTestCase(smallCtx.app, admin, pidSmall, idSmall);
        const tcBig = await getTestCase(bigCtx.app, admin, pidBig, idBig);
        expect(tcSmall.body.title).toBe((obs.observed as any).title);
        expect(tcSmall.body.title).toBe(tcBig.body.title);
        expect(tcSmall.body.fingerprint).toBe(tcBig.body.fingerprint);
        expect(tcSmall.body.status).toBe(tcBig.body.status);
        expect(tcSmall.body.ownership).toBe(tcBig.body.ownership);
        expect(tcSmall.body.is_stale).toBe(tcBig.body.is_stale);
      }
    },
    30_000,
  );

  it('シナリオ10: rollup TTL — last_seen_at が TTL 超の凍結 identity は集約から除外される', async () => {
    const { admin, pid, apiToken } = await setupProjectWithToken(ctx.app, 'proj-ttl', 'sat-ttl');

    const s1 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s1.sync_token, [
      { external_ref: 'ext-ttl-1', fingerprint: 'fp-ttl-1', observed: obsFixture() },
    ]);
    const { final: final1 } = await commitToCompletion(ctx.app, apiToken, pid, s1.sync_token);
    const id1 = final1.mappings[0].test_case_id as string;

    // identity を「TTL(既定90日)超過前に is_stale=1 かつ last_seen_at が古い」状態に直接 seed する
    // (data-model.md「staleness集約ルール」の TTL 判定を検証するための直挿し。brief 「シナリオ10」)。
    const ttlMs = 90 * 24 * 60 * 60 * 1000;
    const frozenLastSeenAt = FIXED_NOW - ttlMs - 1000; // TTL を1秒超過
    await ctx.rawExec(
      `UPDATE test_case_identities SET is_stale=1, last_seen_at=${frozenLastSeenAt} WHERE test_case_id='${id1}'`,
    );
    await ctx.rawExec(`UPDATE test_cases SET is_stale=1 WHERE id='${id1}'`); // TTL 判定前は stale だったと仮定した初期状態

    // 別 ref を同期して rollup(工程7・project 全体対象)を今の clock で再実行させる
    const s2 = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
    await chunkSync(ctx.app, apiToken, pid, s2.sync_token, [
      { external_ref: 'ext-ttl-trigger', fingerprint: 'fp-ttl-trigger', observed: obsFixture() },
    ]);
    await commitToCompletion(ctx.app, apiToken, pid, s2.sync_token);

    const tc = await getTestCase(ctx.app, admin, pid, id1);
    expect(tc.body.is_stale).toBe(false); // 凍結 identity のみのため集約対象から除外され stale が解除される
  });

  // task-16 review round 1(discriminating concurrency test。tests/contract/occ-concurrency.test.ts の
  // libsql 版と同じ不変条件を D1(miniflare)アダプタでも defense-in-depth として確認する)。
  // 同一 token への commit 呼び出しを実際に同時発火する(Promise.all)。commit ルートハンドラは
  // syncCommitWindow を1回だけ呼ぶため(内部でループしない。more:true を返したら呼び出し側が再送する
  // 設計)、2つの同時 POST /commit は「同一 token に対する2つの syncCommitWindow 呼び出しが並行実行
  // される」状況にそのまま対応する。D1 も非同期 I/O のため、各 await 境界(工程0〜1の SELECT/INSERT)が
  // 真にインターリーブしうる。
  it(
    'シナリオ11: commit 並行呼び出し — 同一 token への2つの commit リクエストを同時に投げても' +
      'imported history は重複しない(review round 1: task-16-report.md「Fix report」参照)',
    async () => {
      const { admin, pid, apiToken } = await setupProjectWithToken(ctx.app, 'proj-commit-race', 'sat-commit-race');

      const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
      await chunkSync(ctx.app, apiToken, pid, started.sync_token, [
        { external_ref: 'ext-race-1', fingerprint: 'fp-race-1', observed: obsFixture() },
      ]);

      const [r1, r2] = await Promise.all([
        commitOnce(ctx.app, apiToken, pid, started.sync_token),
        commitOnce(ctx.app, apiToken, pid, started.sync_token),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r1.body).toEqual(r2.body); // 両応答は同一の最終状態を報告する(片方が即応でも中身は一致)

      const id1 = r1.body.mappings.find((m: any) => m.external_ref === 'ext-race-1').test_case_id as string;
      const history = await getHistory(ctx.app, admin, pid, id1);
      expect(history.body.items.filter((h: any) => h.action === 'imported')).toHaveLength(1); // 重複無し

      const list = await listTestCases(ctx.app, admin, pid);
      expect(list.body.items.filter((i: any) => i.id === id1)).toHaveLength(1); // canonical も重複無し
    },
  );
});
