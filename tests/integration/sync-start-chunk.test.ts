// tests/integration/sync-start-chunk.test.ts
// 衛星同期プロトコル 前半(task-15-brief.md「振る舞い」を1行ずつ検証する)の統合テスト。
// docs/sync-protocol.md(start/chunk の全仕様・エラー表・スライディング失効)、docs/api-reference.md
// (origin 正規化・Idempotency-Key=D-10 受理のみ)と1:1で対応させる(GC-1)。実 D1(miniflare binding)+
// 固定クロックを使う(tests/integration/helpers.ts)。commit(Task 16)には依存しない
// (「変化なし ref の別セッション再送」は helpers-seed.ts の seedCommittedObservation で committed な
// 観測を直挿しして代替する。task-14-brief.md と同じ decoupling 方針)。
//
// sync_seen(出現台帳)テスト方針についての注記: sync_seen は Task 15 時点で読み出し API を持たない
// (最初の消費者は Task 16 の commit 工程3/4)。そのため本ファイルは sync_seen の内容そのものを直接
// 検証せず、「変化点のみ記録」(観測行が増えない)という観測可能な副作用と、書き込み経路が例外なく
// 完走すること(sync_seen への INSERT は観測 INSERT と同一メソッド内で常に実行されるため、後者が
// 正しく完走していれば前者も実行されている)を根拠にする。タスク報告にも明記する。
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Hono } from 'hono';
import type { AppEnv } from '../../src/http/app';
import { makeTestApp, wipe, cookieHeader, setupAndLogin, createProject, issueToken, FIXED_NOW, type TestApp } from './helpers';
import { seedCommittedObservation } from './helpers-seed';

function jsonReq(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** Bearer 認証付きリクエストの共通オプション。 */
function bearerReq(method: string, token: string, body?: unknown, headers: Record<string, string> = {}) {
  return jsonReq(method, body, { Authorization: `Bearer ${token}`, ...headers });
}

/** observed の固定キーセット(data-model.md)を満たす最小フィクスチャ。 */
const OBS_FIXTURE = { title: 't', given: 'g', when: 'w', then: 'th', parameters: [], source_ref: {}, schema_version: '1.0' };

function startUrl(pid: string) {
  return `/api/v1/projects/${pid}/sync/start`;
}
function chunkUrl(pid: string, token: string) {
  return `/api/v1/projects/${pid}/sync/${token}/chunk`;
}

/** POST /sync/start を実行し、201 body をパースして返す(失敗時は例外。issueToken と同じ規約)。 */
async function startSync(app: Hono<AppEnv>, apiToken: string, pid: string, origin: string) {
  const res = await app.request(startUrl(pid), bearerReq('POST', apiToken, { origin }));
  if (res.status !== 201) throw new Error(`startSync: start failed with status ${res.status}: ${await res.text()}`);
  return res.json<any>();
}

/** admin セッションで project 作成 + editor 相当のトークン発行までを1回で行う共通セットアップ。 */
async function setupProjectWithToken(ctx: TestApp, projectName = 'discovery-project', tokenName = 'discovery-sat') {
  const admin = await setupAndLogin(ctx.app);
  const project = await createProject(ctx.app, admin, projectName);
  const apiToken = await issueToken(ctx.app, admin, project.body.id, tokenName);
  return { admin, pid: project.body.id as string, apiToken };
}

describe('統合: 同期プロトコル start/chunk(task-15-brief.md)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await makeTestApp();
    await wipe(ctx.rawExec);
  });

  describe('POST /api/v1/projects/:pid/sync/start(sync-protocol.md)', () => {
    it('有効な Bearer → 201 {sync_token, expires_at, server_time, max_chunk_size:500}', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);

      const res = await ctx.app.request(startUrl(pid), bearerReq('POST', apiToken, { origin: 'discovery-v1' }));
      expect(res.status).toBe(201);
      const body = await res.json<any>();
      expect(body).toEqual({
        sync_token: expect.stringMatching(/^syn_/),
        expires_at: FIXED_NOW + 10 * 60_000,
        server_time: FIXED_NOW,
        max_chunk_size: 500,
      });
    });

    it('同一 (project,origin) の active が既存 → 409 DUPLICATE_SYNC_SESSION', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);

      const first = await ctx.app.request(startUrl(pid), bearerReq('POST', apiToken, { origin: 'discovery-v1' }));
      expect(first.status).toBe(201);

      const second = await ctx.app.request(startUrl(pid), bearerReq('POST', apiToken, { origin: 'discovery-v1' }));
      expect(second.status).toBe(409);
      expect((await second.json<any>()).error.code).toBe('DUPLICATE_SYNC_SESSION');
    });

    it('別 origin なら並行 start 可 → 201', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);

      const first = await ctx.app.request(startUrl(pid), bearerReq('POST', apiToken, { origin: 'discovery-v1' }));
      expect(first.status).toBe(201);
      const second = await ctx.app.request(startUrl(pid), bearerReq('POST', apiToken, { origin: 'selfheal-v1' }));
      expect(second.status).toBe(201);
    });

    it('期限切れ active が居る状態で start → 旧セッションを expired に倒して201(遅延評価)', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);

      const first = await ctx.app.request(startUrl(pid), bearerReq('POST', apiToken, { origin: 'discovery-v1' }));
      expect(first.status).toBe(201);
      const firstBody = await first.json<any>();

      ctx.advance(10 * 60_000 + 1); // スライディング失効(10分)を超過させる

      const second = await ctx.app.request(startUrl(pid), bearerReq('POST', apiToken, { origin: 'discovery-v1' }));
      expect(second.status).toBe(201);
      const secondBody = await second.json<any>();
      expect(secondBody.sync_token).not.toBe(firstBody.sync_token); // 新しいセッションが発行された

      // 旧セッションが本当に expired に倒れていなければ、新セッションと合わせて同一 origin に active が
      // 2つ存在してしまい DB 制約違反になるはず。3回目の start が「新セッションと」衝突して409になる
      // ことが、旧セッションはもう active でない(=新セッションだけが active)ことの間接的な証明になる。
      const third = await ctx.app.request(startUrl(pid), bearerReq('POST', apiToken, { origin: 'discovery-v1' }));
      expect(third.status).toBe(409);
    });

    it('token と別プロジェクトの :pid → 403 CROSS_TENANT', async () => {
      const admin = await setupAndLogin(ctx.app);
      const projectA = await createProject(ctx.app, admin, 'project-a');
      const projectB = await createProject(ctx.app, admin, 'project-b');
      const tokenForA = await issueToken(ctx.app, admin, projectA.body.id, 'sat-a');

      const res = await ctx.app.request(startUrl(projectB.body.id), bearerReq('POST', tokenForA, { origin: 'discovery-v1' }));
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('CROSS_TENANT');
    });

    it('origin が大文字を含む → 422 VALIDATION_FAILED(origin 正規化規約。api-reference.md)', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);

      const res = await ctx.app.request(startUrl(pid), bearerReq('POST', apiToken, { origin: 'DISCOVERY-V1' }));
      expect(res.status).toBe(422);
      expect((await res.json<any>()).error.code).toBe('VALIDATION_FAILED');
    });

    it('session Cookie(UI ユーザー)は到達不可(能力マトリクス: token 専用ルート宣言)', async () => {
      const admin = await setupAndLogin(ctx.app);
      const project = await createProject(ctx.app, admin, 'session-blocked');

      const res = await ctx.app.request(
        startUrl(project.body.id),
        jsonReq('POST', { origin: 'discovery-v1' }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(401); // Bearer 無し・modes:['token'] のみのため 401 UNAUTHORIZED
    });
  });

  describe('POST /api/v1/projects/:pid/sync/:token/chunk(sync-protocol.md)', () => {
    it('chunk 正常 → 200 {accepted, received}。expires_at がスライディング延長される', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);
      const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');

      const res = await ctx.app.request(
        chunkUrl(pid, started.sync_token),
        bearerReq('POST', apiToken, { observations: [{ external_ref: 'ext-1', fingerprint: 'fp-1', observed: OBS_FIXTURE }] }),
      );
      expect(res.status).toBe(200);
      expect(await res.json<any>()).toEqual({ accepted: 1, received: [{ external_ref: 'ext-1', outcome: 'inserted' }] });

      // スライディング延長の検証(HTTP のみ): chunk 時刻(FIXED_NOW)から9分進めると、
      // 「元の start の失効(+10分)」からは1分手前だが「chunk による延長後の失効」からも1分手前
      // なので、この時点ではまだ判別できない。もう9分進めて「元の失効は超過済みだが延長後の失効は
      // 超過していない」時刻にし、chunk がまだ 200 で通ることを延長の証拠とする。
      ctx.advance(9 * 60_000);
      const stillOk = await ctx.app.request(
        chunkUrl(pid, started.sync_token),
        bearerReq('POST', apiToken, { observations: [{ external_ref: 'ext-1', fingerprint: 'fp-1', observed: OBS_FIXTURE }] }),
      );
      expect(stillOk.status).toBe(200); // この時点で now = start+9分。この chunk が now+10分へ再延長する

      ctx.advance(9 * 60_000); // now = start+18分。延長前の失効(start+10分)はとうに超過しているが、
      // 直前の chunk(start+9分時点)による延長後の失効(start+19分)にはまだ達していない
      const extendedStillOk = await ctx.app.request(
        chunkUrl(pid, started.sync_token),
        bearerReq('POST', apiToken, { observations: [{ external_ref: 'ext-1', fingerprint: 'fp-1', observed: OBS_FIXTURE }] }),
      );
      expect(extendedStillOk.status).toBe(200); // 延長されていなければここは410になるはず
    });

    it('同一 chunk 再送(同一セッション)→ 全件 duplicate・観測行は増えない', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);
      const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
      const body = { observations: [{ external_ref: 'ext-resend', fingerprint: 'fp-resend', observed: OBS_FIXTURE }] };

      const first = await ctx.app.request(chunkUrl(pid, started.sync_token), bearerReq('POST', apiToken, body));
      expect(await first.json<any>()).toEqual({ accepted: 1, received: [{ external_ref: 'ext-resend', outcome: 'inserted' }] });

      // ネットワーク再送・同一チャンク再送を模す(sync-protocol.md「冪等性の保証」)。
      const second = await ctx.app.request(chunkUrl(pid, started.sync_token), bearerReq('POST', apiToken, body));
      expect(second.status).toBe(200);
      expect(await second.json<any>()).toEqual({ accepted: 1, received: [{ external_ref: 'ext-resend', outcome: 'duplicate' }] });
      // 観測行が増えていれば fingerprint 比較の前提が壊れ、3回目も 'inserted' に戻ってしまう。
      const third = await ctx.app.request(chunkUrl(pid, started.sync_token), bearerReq('POST', apiToken, body));
      expect(await third.json<any>()).toEqual({ accepted: 1, received: [{ external_ref: 'ext-resend', outcome: 'duplicate' }] });
    });

    it(
      '変化なし ref の別セッション再送 → 観測行は増えない(変化点のみ)。sync_seen への記録は書込経路の' +
        '正常完走(下記コメント参照)で担保する',
      async () => {
        const { admin, pid, apiToken } = await setupProjectWithToken(ctx);
        // commit(Task 16)未実装のため、helpers-seed.ts で「前回 committed 済みの観測」を直挿しする
        // (task-14-brief.md と同じ decoupling 方針)。
        const created = await (
          await ctx.app.request(
            `/api/v1/projects/${pid}/testcases`,
            jsonReq(
              'POST',
              {
                title: 'carryover', category: 'normal', given: 'g', when: 'w', then: 't',
              },
              { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' },
            ),
          )
        ).json<any>();
        await seedCommittedObservation(ctx.rawExec, {
          pid, testCaseId: created.id, externalRef: 'ext-carryover', origin: 'discovery-v1',
          fingerprint: 'fp-carryover', observed: OBS_FIXTURE, at: FIXED_NOW - 1000,
        });

        const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
        const res = await ctx.app.request(
          chunkUrl(pid, started.sync_token),
          bearerReq('POST', apiToken, {
            observations: [{ external_ref: 'ext-carryover', fingerprint: 'fp-carryover', observed: OBS_FIXTURE }],
          }),
        );
        expect(res.status).toBe(200);
        // fingerprint が committed 観測と一致 → duplicate(新しい観測行は作られない)。
        // sync_seen への INSERT は syncAppendObservations 内で観測 INSERT と同じ呼び出しの一部として
        // 無条件に実行される(Task 15 時点では読み出し API が無いため直接検証できない。最初の消費者は
        // Task 16 の commit 工程3/4。タスク報告に明記)。
        expect(await res.json<any>()).toEqual({ accepted: 1, received: [{ external_ref: 'ext-carryover', outcome: 'duplicate' }] });
      },
    );

    it('token と別プロジェクトの :pid → 403 CROSS_TENANT', async () => {
      const admin = await setupAndLogin(ctx.app);
      const projectA = await createProject(ctx.app, admin, 'chunk-project-a');
      const projectB = await createProject(ctx.app, admin, 'chunk-project-b');
      const tokenForA = await issueToken(ctx.app, admin, projectA.body.id, 'sat-a');
      const started = await startSync(ctx.app, tokenForA, projectA.body.id, 'discovery-v1');

      const res = await ctx.app.request(
        chunkUrl(projectB.body.id, started.sync_token),
        bearerReq('POST', tokenForA, { observations: [{ external_ref: 'ext-1', fingerprint: 'fp-1', observed: OBS_FIXTURE }] }),
      );
      expect(res.status).toBe(403);
      expect((await res.json<any>()).error.code).toBe('CROSS_TENANT');
    });

    it('存在しない token → 410 SESSION_EXPIRED', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);

      const res = await ctx.app.request(
        chunkUrl(pid, 'syn_does-not-exist'),
        bearerReq('POST', apiToken, { observations: [{ external_ref: 'ext-1', fingerprint: 'fp-1', observed: OBS_FIXTURE }] }),
      );
      expect(res.status).toBe(410);
      expect((await res.json<any>()).error.code).toBe('SESSION_EXPIRED');
    });

    it('期限切れセッションへの chunk → 410 SESSION_EXPIRED(遅延評価で expired に倒れる)', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);
      const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');

      ctx.advance(10 * 60_000 + 1); // スライディング失効(10分)を超過させる

      const res = await ctx.app.request(
        chunkUrl(pid, started.sync_token),
        bearerReq('POST', apiToken, { observations: [{ external_ref: 'ext-1', fingerprint: 'fp-1', observed: OBS_FIXTURE }] }),
      );
      expect(res.status).toBe(410);
      expect((await res.json<any>()).error.code).toBe('SESSION_EXPIRED');
    });

    it('committed セッションへの chunk → 410 SESSION_EXPIRED(committed 後は受け付けない)', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);
      const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
      await ctx.rawExec(`UPDATE sync_sessions SET status='committed', committed_at=${FIXED_NOW} WHERE token='${started.sync_token}'`);

      const res = await ctx.app.request(
        chunkUrl(pid, started.sync_token),
        bearerReq('POST', apiToken, { observations: [{ external_ref: 'ext-1', fingerprint: 'fp-1', observed: OBS_FIXTURE }] }),
      );
      expect(res.status).toBe(410);
      expect((await res.json<any>()).error.code).toBe('SESSION_EXPIRED');
    });

    it('observations が501件(> max_chunk_size 500)→ 422 VALIDATION_FAILED', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);
      const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
      const tooMany = Array.from({ length: 501 }, (_, i) => ({ external_ref: `ext-${i}`, fingerprint: `fp-${i}`, observed: OBS_FIXTURE }));

      const res = await ctx.app.request(chunkUrl(pid, started.sync_token), bearerReq('POST', apiToken, { observations: tooMany }));
      expect(res.status).toBe(422);
      expect((await res.json<any>()).error.code).toBe('VALIDATION_FAILED');
    });

    it('observed が256KB超 → 422 VALIDATION_FAILED(D1 行サイズ2MB上限対応の Zod 検証)', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);
      const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
      const oversized = { ...OBS_FIXTURE, source_ref: { blob: 'x'.repeat(300_000) } };

      const res = await ctx.app.request(
        chunkUrl(pid, started.sync_token),
        bearerReq('POST', apiToken, { observations: [{ external_ref: 'ext-big', fingerprint: 'fp-big', observed: oversized }] }),
      );
      expect(res.status).toBe(422);
      expect((await res.json<any>()).error.code).toBe('VALIDATION_FAILED');
    });

    it('observation の category(任意・enum)を受理する。不正な値は 422 VALIDATION_FAILED(docs ギャップ解消)', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);
      const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');

      const ok = await ctx.app.request(
        chunkUrl(pid, started.sync_token),
        bearerReq('POST', apiToken, {
          observations: [{ external_ref: 'ext-cat', fingerprint: 'fp-cat', observed: OBS_FIXTURE, category: 'boundary' }],
        }),
      );
      expect(ok.status).toBe(200);

      const bad = await ctx.app.request(
        chunkUrl(pid, started.sync_token),
        bearerReq('POST', apiToken, {
          observations: [{ external_ref: 'ext-cat2', fingerprint: 'fp-cat2', observed: OBS_FIXTURE, category: 'not-a-real-category' }],
        }),
      );
      expect(bad.status).toBe(422);
      expect((await bad.json<any>()).error.code).toBe('VALIDATION_FAILED');
    });

    it('Idempotency-Key ヘッダ: 受理するが無視する(D-10。メモ化せず毎回実際の内容で処理する)', async () => {
      const { pid, apiToken } = await setupProjectWithToken(ctx);
      const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');

      const res1 = await ctx.app.request(
        chunkUrl(pid, started.sync_token),
        bearerReq(
          'POST', apiToken,
          { observations: [{ external_ref: 'ext-idem-a', fingerprint: 'fp-idem-a', observed: OBS_FIXTURE }] },
          { 'Idempotency-Key': 'same-client-key-123' },
        ),
      );
      expect(res1.status).toBe(200);
      expect(await res1.json<any>()).toEqual({ accepted: 1, received: [{ external_ref: 'ext-idem-a', outcome: 'inserted' }] });

      // 同一 Idempotency-Key だが中身が異なるリクエスト → メモ化されていればキャッシュされた res1 が
      // 返ってしまうが、D-10「受理して無視」なので実際の内容(ext-idem-b)どおりに処理される。
      const res2 = await ctx.app.request(
        chunkUrl(pid, started.sync_token),
        bearerReq(
          'POST', apiToken,
          { observations: [{ external_ref: 'ext-idem-b', fingerprint: 'fp-idem-b', observed: OBS_FIXTURE }] },
          { 'Idempotency-Key': 'same-client-key-123' },
        ),
      );
      expect(res2.status).toBe(200);
      expect(await res2.json<any>()).toEqual({ accepted: 1, received: [{ external_ref: 'ext-idem-b', outcome: 'inserted' }] });
    });

    it('session Cookie(UI ユーザー)は到達不可(能力マトリクス: token 専用ルート宣言)', async () => {
      const { admin, pid } = await setupProjectWithToken(ctx);
      const started_token = 'syn_irrelevant'; // 401 は認証段階で弾かれるため実在トークンは不要

      const res = await ctx.app.request(
        chunkUrl(pid, started_token),
        jsonReq('POST', { observations: [] }, { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' }),
      );
      expect(res.status).toBe(401);
    });

    it(
      'syncLimiter 超過(トークン別120/分。D-14)→ 429 + Retry-After(start 1回 + chunk 119回で120消費、' +
        '121回目の呼び出し(chunk)が429になる)',
      async () => {
        const { pid, apiToken } = await setupProjectWithToken(ctx);
        const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1'); // 1回目の消費

        const chunkBody = { observations: [{ external_ref: 'ext-rl', fingerprint: 'fp-rl', observed: OBS_FIXTURE }] };
        for (let i = 0; i < 119; i++) {
          const res = await ctx.app.request(chunkUrl(pid, started.sync_token), bearerReq('POST', apiToken, chunkBody));
          expect(res.status).toBe(200);
        }

        const blocked = await ctx.app.request(chunkUrl(pid, started.sync_token), bearerReq('POST', apiToken, chunkBody));
        expect(blocked.status).toBe(429);
        expect((await blocked.json<any>()).error.code).toBe('RATE_LIMITED');
        expect(blocked.headers.get('Retry-After')).toBe('60'); // windowMs=60_000・クロック未進行のため ceil(60000/1000)
      },
      30_000,
    );

    // review round 1(CRITICAL D1 bind overflow)。syncAppendObservations の①committed-JOINフェンス SELECT
    // は inArray(refs) で ref 1件につき1バインドを消費するため、修正前は projectId/origin/session.token の
    // 3バインドと合わせて `refs.length + 3` バインドになり、distinct external_ref が97件を超える chunk で
    // D1 の「1文あたり bind ≤100」制約(sync-protocol.md「D1 制約」)を実行時に超過していた
    // (MAX_CHUNK_SIZE=500 の範囲内で普通に起こりうる。例: 既存テストスイートの初回一括同期)。
    // ここでは実 D1(miniflare。本ファイルは workers pool 実行)に対して、上限97を安全に超え、かつ
    // FENCE_REFS_BATCH_SIZE=90 での複数バッチ分割・マージも exercise する250件の distinct external_ref を
    // 送る。修正前のコードに対してはこのテストが "D1_ERROR: too many SQL variables" で落ちることを
    // 確認済み(タスク報告参照)。
    it(
      'review round 1(CRITICAL D1 bind overflow): distinct external_ref が250件(>100、複数バッチにまたがる)の' +
        'chunkでも committed-JOINフェンス SELECT が D1 の bind上限(≤100)を超えず 200 で全件処理される',
      async () => {
        const { pid, apiToken } = await setupProjectWithToken(ctx, 'large-chunk-project', 'large-chunk-sat');
        const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');

        // MAX_CHUNK_SIZE=500 の範囲内(422にならない)。初回一括同期を模す既存観測ゼロの状態のため、
        // ①のフェンス SELECT は(バッチ分割されていても)全 ref で0件ヒットし、全件 inserted になるはず。
        const N = 250;
        const observations = Array.from({ length: N }, (_, i) => ({
          external_ref: `ext-large-${i}`,
          fingerprint: `fp-large-${i}`,
          observed: OBS_FIXTURE,
        }));

        const res = await ctx.app.request(chunkUrl(pid, started.sync_token), bearerReq('POST', apiToken, { observations }));
        expect(res.status).toBe(200);
        const body = await res.json<any>();
        expect(body.accepted).toBe(N);
        expect(body.received).toHaveLength(N);

        const outcomeByRef = new Map<string, string>(body.received.map((r: any) => [r.external_ref, r.outcome]));
        expect(outcomeByRef.size).toBe(N); // 全件が received に含まれる(欠落なし)
        for (let i = 0; i < N; i++) {
          expect(outcomeByRef.get(`ext-large-${i}`)).toBe('inserted');
        }
      },
    );

    // 重要(sync_seen 出現台帳の全件記録): sync_seen は「chunkで受信した全 ref(変化点の有無を問わず)」を
    // 記録する出現台帳であり、Task 16 の commit 工程3/4(stale 判定)はこれを根拠にする(sync-protocol.md
    // 「変化点のみ記録」との緊張関係を解決する設計。task-15-brief.md「⚠ 設計上の重要ノート」参照)。
    // 実装は正しい(seenRows は変化点フィルタ前の全 ref から作られる)が、これまで sync_seen の中身を
    // 直接検証するテストが無かった。
    //
    // review round 2(非判別テストの修正): 当初この検証は「同一セッション内で ext-seen-a を1st chunk で
    // 新規投入(inserted)し、2nd chunk で再送(duplicate)」という構成だったが、これでは changed-only 回帰
    // (seenRows を refs 全体ではなく changedRefs のみから作るバグ)を検知できない。ext-seen-a は1st chunk
    // 時点では「初出」= changed 扱いのため、正しい実装・回帰した実装のどちらでも1st chunk の時点で
    // sync_seen へ書かれてしまい、2nd chunk の再送はその既存行に対する ON CONFLICT DO NOTHING の
    // 冪等 INSERT にしかならない。つまり最終的な sync_seen の中身はどちらの実装でも
    // {ext-seen-a, ext-seen-c} に一致し、区別できなかった。
    // 対策として、helpers-seed.ts の seedCommittedObservation で「前回 committed 済みの観測」を DB に
    // 直挿しする(seedCommittedObservation は sync_sessions/test_case_observations/test_case_identities
    // のみへ書き込み、sync_seen には一切書き込まない)。これにより、これから開始する新規セッションの
    // 最初のチャンクの時点で ext-seen-x はすでに committed-JOIN フェンスの比較対象になっており、
    // fingerprint 一致で最初から duplicate 判定になる(このセッション内では一度も「changed」になった
    // ことがない)。この状態でもこのセッションの sync_token に ext-seen-x の sync_seen 行が存在すれば、
    // それは refs 全体から seenRows を作る(append-all)実装でしか説明がつかない。changed-only 回帰の下
    // では ext-seen-x はこのセッションの sync_seen に一度も現れないため、欠落として検知できる。
    it(
      '重要: committed 基準と比べて fingerprint 不変(duplicate)の ref も、新規(inserted)ref と同様に' +
        'そのセッションの sync_seen へ記録される(changed-only 回帰の検知。env.DB を直接クエリして検証)',
      async () => {
        const { admin, pid, apiToken } = await setupProjectWithToken(ctx, 'sync-seen-project', 'sync-seen-sat');

        // commit(Task 16)未実装のため、helpers-seed.ts で「前回 committed 済みの観測」を直挿しする
        // (task-14-brief.md と同じ decoupling 方針。「変化なし ref の別セッション再送」と同じ構成)。
        // seedCommittedObservation は sync_seen に書き込まないため、ext-seen-x はこの時点で
        // sync_seen 行を1つも持たない。
        const created = await (
          await ctx.app.request(
            `/api/v1/projects/${pid}/testcases`,
            jsonReq(
              'POST',
              { title: 'seen-baseline', category: 'normal', given: 'g', when: 'w', then: 't' },
              { Cookie: cookieHeader(admin.jar), 'x-csrf-token': admin.csrf ?? '' },
            ),
          )
        ).json<any>();
        await seedCommittedObservation(ctx.rawExec, {
          pid, testCaseId: created.id, externalRef: 'ext-seen-x', origin: 'discovery-v1',
          fingerprint: 'fp-seen-x', observed: OBS_FIXTURE, at: FIXED_NOW - 1000,
        });

        // フレッシュな(新規の)セッションを開始する。ext-seen-x はこのセッションではまだ一度も
        // 送信されていない = このセッション内では一度も「changed」になっていない。
        const started = await startSync(ctx.app, apiToken, pid, 'discovery-v1');
        const res = await ctx.app.request(
          chunkUrl(pid, started.sync_token),
          bearerReq('POST', apiToken, {
            observations: [
              // committed 基準の fingerprint と一致 → duplicate(観測行は作られない)。
              { external_ref: 'ext-seen-x', fingerprint: 'fp-seen-x', observed: OBS_FIXTURE },
              // 初出 → inserted。
              { external_ref: 'ext-seen-y', fingerprint: 'fp-seen-y', observed: OBS_FIXTURE },
            ],
          }),
        );
        expect(res.status).toBe(200);
        const body = await res.json<any>();
        expect(body.accepted).toBe(2);
        expect(body.received).toEqual(expect.arrayContaining([
          { external_ref: 'ext-seen-x', outcome: 'duplicate' },
          { external_ref: 'ext-seen-y', outcome: 'inserted' },
        ]));

        // このセッション(sync_token)の sync_seen に ext-seen-x(duplicate)・ext-seen-y(inserted)の
        // 両方が記録されていることを検証する。changed-only 回帰(seenRows を changedRefs のみから作る)
        // の下では、ext-seen-x はこのセッションで一度も changed になっていないため sync_seen から
        // 欠落するはず(discriminates)。
        const seenRows = await env.DB
          .prepare('SELECT external_ref FROM sync_seen WHERE sync_token = ?')
          .bind(started.sync_token)
          .all<{ external_ref: string }>();
        const seenRefs = (seenRows.results ?? []).map((r) => r.external_ref).sort();
        expect(seenRefs).toEqual(['ext-seen-x', 'ext-seen-y']);
      },
    );
  });
});
