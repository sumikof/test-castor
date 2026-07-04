// tests/unit/maintenance.test.ts
// task-22-brief.md「メンテナンス(パージ・sweep)」。better-sqlite3 で高速検証する(brief 明記)。
// docs/operations.md §4(パージの削除述語・per-origin最低1件保持・小バッチ・1,000クエリ未満)、
// docs/sync-protocol.md「失効の執行モデル」(Cron sweep はセカンダリ)、docs/data-model.md
// 「パージポリシー」を実装前に読み、各不変条件を discriminating data(2 origin・複数 test case・
// active/committed/expired の混在)で検証する。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBetterSqlite3Storage } from '../../src/storage/adapters/better-sqlite3';
import type { Storage, OrgScope, NewTestCaseColumns, NewHistoryEntry } from '../../src/storage/interface';
import { purgeObservationsUntilDone, purgeSyncWorkdataUntilDone } from '../../src/maintenance/purge';
import { sweepExpired } from '../../src/maintenance/sweep';
import { runMaintenance, type MaintenanceDeps } from '../../src/maintenance';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 90 * DAY_MS;
const BASE_NOW = 1_700_000_000_000; // メンテナンス実行時刻(「今」)
const OLD_TS = BASE_NOW - RETENTION_MS - DAY_MS; // 91日前(retention超)
const RECENT_TS = BASE_NOW - 10 * DAY_MS; // retention内

function obsPayload() {
  return { title: 't', given: 'g', when: 'w', then: 'th', parameters: [], source_ref: {}, schema_version: '1.0' };
}

function tcInput(overrides: Partial<NewTestCaseColumns> = {}): NewTestCaseColumns {
  return {
    title: 'サンプル', target: null, category: 'normal', given: 'g', when: 'w', then: 't',
    parameters: null, status: 'draft', confidence: null, sourceRef: null, metadata: null, ...overrides,
  };
}
function historyEntry(overrides: Partial<NewHistoryEntry> = {}): NewHistoryEntry {
  return { actor: 'user:00000000-0000-0000-0000-0000000000ff', action: 'created', delta: {}, ...overrides };
}

/** more:true の間 syncCommitWindow を呼び続けて収束させる(tests/contract/storage-contract.ts と同じ規約)。 */
async function commitToConvergence(
  storage: Storage, scope: OrgScope, pid: string, token: string,
  params: { now: number; identityTtlMs: number; windowLimit: number; actor: string },
): Promise<void> {
  let more = true;
  let iterations = 0;
  while (more) {
    iterations++;
    if (iterations > 50) throw new Error('commitToConvergence: exceeded safety cap(50) — possible livelock');
    const r = await storage.syncCommitWindow(scope, pid, token, { ...params, now: params.now + iterations });
    more = r.more;
  }
}

/**
 * syncStart → 複数回 syncAppendObservations(異なる fingerprint = 変化点ごとに新規観測行)→
 * commit 収束 → syncFinalize までを1本化し、committed な test_case_id を返す(観測の created_at を
 * 個別に制御できるようにするための purge テスト専用ヘルパ)。
 */
async function seedCommittedTestCase(
  storage: Storage, scope: OrgScope, pid: string,
  opts: {
    token: string; origin: string; externalRef: string;
    entries: Array<{ fingerprint: string; createdAt: number }>; commitNow: number;
  },
): Promise<string> {
  const started = await storage.syncStart(scope, pid, {
    token: opts.token, origin: opts.origin, now: opts.entries[0]!.createdAt, slidingMs: 365 * DAY_MS,
  });
  if (started.kind !== 'created') throw new Error('seedCommittedTestCase: syncStart conflict');
  for (const e of opts.entries) {
    await storage.syncAppendObservations(scope, pid, started.session, [
      { externalRef: opts.externalRef, fingerprint: e.fingerprint, observed: obsPayload(), category: null, confidence: null },
    ], e.createdAt);
  }
  await commitToConvergence(storage, scope, pid, opts.token, {
    now: opts.commitNow, identityTtlMs: 365 * DAY_MS, windowLimit: 1000, actor: 'token:test-actor',
  });
  await storage.syncFinalize(scope, pid, opts.token, opts.commitNow + 1);
  const mappings = await storage.syncMappings(scope, pid, opts.token);
  const m = mappings.find((x) => x.externalRef === opts.externalRef);
  if (!m) throw new Error(`seedCommittedTestCase: mapping not found for ${opts.externalRef}`);
  return m.testCaseId;
}

describe('maintenance(task-22-brief.md)', () => {
  let ctx: ReturnType<typeof createBetterSqlite3Storage>;
  let scope: OrgScope;

  beforeEach(async () => {
    ctx = createBetterSqlite3Storage(':memory:');
    const r = await ctx.storage.setupOrganization({
      orgName: 'org', adminEmail: 'admin@example.com', adminPasswordHash: '$pbkdf2-sha256$i=1$x$y',
      adminDisplayName: 'Admin', now: BASE_NOW,
    });
    scope = { organizationId: r.organization.id };
  });

  // --- Storage.purgeObservations(不変条件そのもの) -----------------------------------------

  describe('Storage.purgeObservations', () => {
    it(
      'committedかつ90日超は削除 / 各(test_case,origin)の直近committed観測は91日前でも残す / ' +
        '単発でも古いだけなら残す(サバイバー規則) / recentは残す / active由来は絶対に消さない' +
        '(2 origin × 5 test case の discriminating data)',
      async () => {
        const { storage, sqlite } = ctx;
        const p = await storage.createProject(scope, { name: 'proj-purge' }, BASE_NOW);

        // TC-A(origin discovery-v1): old(削除対象)+ old+500ms(このペアの最新survivor。まだ91日前級だが残る)
        await seedCommittedTestCase(storage, scope, p.id, {
          token: 'tok-a', origin: 'discovery-v1', externalRef: 'ext-a',
          entries: [{ fingerprint: 'fp-a-old', createdAt: OLD_TS }, { fingerprint: 'fp-a-latest', createdAt: OLD_TS + 500 }],
          commitNow: OLD_TS + 1000,
        });
        // TC-B(別origin selfheal-v1): 同型。origin をまたいでpartitionが正しく効くことの証拠
        await seedCommittedTestCase(storage, scope, p.id, {
          token: 'tok-b', origin: 'selfheal-v1', externalRef: 'ext-b',
          entries: [{ fingerprint: 'fp-b-old', createdAt: OLD_TS }, { fingerprint: 'fp-b-latest', createdAt: OLD_TS + 500 }],
          commitNow: OLD_TS + 1000,
        });
        // TC-C(discovery-v1・単発・recent): そもそもretention内。survivor規則を経由せず残る
        await seedCommittedTestCase(storage, scope, p.id, {
          token: 'tok-c', origin: 'discovery-v1', externalRef: 'ext-c',
          entries: [{ fingerprint: 'fp-c-recent', createdAt: RECENT_TS }],
          commitNow: RECENT_TS + 1000,
        });
        // TC-D: active(未commit)セッション由来。古いが対象外(committedフィルタで除外される)
        const startedActive = await storage.syncStart(scope, p.id, {
          token: 'tok-d-active', origin: 'discovery-v1', now: OLD_TS, slidingMs: 365 * DAY_MS,
        });
        if (startedActive.kind !== 'created') throw new Error('unreachable');
        await storage.syncAppendObservations(scope, p.id, startedActive.session, [
          { externalRef: 'ext-d', fingerprint: 'fp-d-active', observed: obsPayload(), category: null, confidence: null },
        ], OLD_TS);
        // TC-E(selfheal-v1・単発・old。兄弟観測が無い): TC-Aのように2件の中から選ばれた最新ではなく、
        // 「そもそも1件しかない」ケースでもROW_NUMBER=1として保護されることの証拠(TC-Cはrecentなので
        // 別の理由でも残ってしまい、サバイバー規則そのものの検証にならない。TC-Eはretention超のみで
        // 保護される必要がある)。
        await seedCommittedTestCase(storage, scope, p.id, {
          token: 'tok-e', origin: 'selfheal-v1', externalRef: 'ext-e',
          entries: [{ fingerprint: 'fp-e-lone-old', createdAt: OLD_TS }],
          commitNow: OLD_TS + 1000,
        });

        const fingerprintsOf = (): string[] =>
          (sqlite.prepare('SELECT fingerprint FROM test_case_observations ORDER BY fingerprint').all() as Array<{ fingerprint: string }>)
            .map((r) => r.fingerprint);

        expect(fingerprintsOf().sort()).toEqual(
          ['fp-a-old', 'fp-a-latest', 'fp-b-old', 'fp-b-latest', 'fp-c-recent', 'fp-d-active', 'fp-e-lone-old'].sort(),
        );

        const deleted = await storage.purgeObservations({ now: BASE_NOW, retentionMs: RETENTION_MS, batchLimit: 100 });

        expect(deleted).toBe(2); // fp-a-old, fp-b-old のみ(fp-e-lone-oldはサバイバー規則で残る)
        expect(fingerprintsOf().sort()).toEqual(
          ['fp-a-latest', 'fp-b-latest', 'fp-c-recent', 'fp-d-active', 'fp-e-lone-old'].sort(),
        );
      },
    );

    it('batchLimit=1 を繰り返し呼ぶと1件ずつ削除し、複数回の反復で全削除対象(2件)に到達する。survivorは最後まで残る', async () => {
      const { storage, sqlite } = ctx;
      const p = await storage.createProject(scope, { name: 'proj-purge-batch1' }, BASE_NOW);
      await seedCommittedTestCase(storage, scope, p.id, {
        token: 'tok-a', origin: 'discovery-v1', externalRef: 'ext-a',
        entries: [{ fingerprint: 'fp-a-old', createdAt: OLD_TS }, { fingerprint: 'fp-a-latest', createdAt: OLD_TS + 500 }],
        commitNow: OLD_TS + 1000,
      });
      await seedCommittedTestCase(storage, scope, p.id, {
        token: 'tok-b', origin: 'selfheal-v1', externalRef: 'ext-b',
        entries: [{ fingerprint: 'fp-b-old', createdAt: OLD_TS }, { fingerprint: 'fp-b-latest', createdAt: OLD_TS + 500 }],
        commitNow: OLD_TS + 1000,
      });

      const perCall: number[] = [];
      for (let i = 0; i < 10; i++) {
        const n = await storage.purgeObservations({ now: BASE_NOW, retentionMs: RETENTION_MS, batchLimit: 1 });
        perCall.push(n);
        if (n === 0) break;
      }
      // 2件の削除対象を1件ずつ、3回目で0(反復回数 > 1 の直接証拠。1回のDELETE...LIMITでは終わらない)
      expect(perCall).toEqual([1, 1, 0]);

      const remaining = (sqlite.prepare('SELECT fingerprint FROM test_case_observations ORDER BY fingerprint').all() as Array<{ fingerprint: string }>)
        .map((r) => r.fingerprint);
      expect(remaining.sort()).toEqual(['fp-a-latest', 'fp-b-latest'].sort());
    });
  });

  // --- src/maintenance/purge.ts(反復ドライバ。1,000クエリ未満に抑えるmaxIterations安全弁) --------

  describe('purge.ts: purgeObservationsUntilDone', () => {
    it('maxIterationsが十分なら収束し、合計削除件数と実際の反復回数を返す', async () => {
      const { storage } = ctx;
      const p = await storage.createProject(scope, { name: 'proj-loop' }, BASE_NOW);
      await seedCommittedTestCase(storage, scope, p.id, {
        token: 'tok-a', origin: 'discovery-v1', externalRef: 'ext-a',
        entries: [{ fingerprint: 'fp-a-old', createdAt: OLD_TS }, { fingerprint: 'fp-a-latest', createdAt: OLD_TS + 500 }],
        commitNow: OLD_TS + 1000,
      });
      await seedCommittedTestCase(storage, scope, p.id, {
        token: 'tok-b', origin: 'selfheal-v1', externalRef: 'ext-b',
        entries: [{ fingerprint: 'fp-b-old', createdAt: OLD_TS }, { fingerprint: 'fp-b-latest', createdAt: OLD_TS + 500 }],
        commitNow: OLD_TS + 1000,
      });

      const result = await purgeObservationsUntilDone(storage, { now: BASE_NOW, retentionMs: RETENTION_MS, batchLimit: 1, maxIterations: 10 });
      expect(result).toEqual({ deleted: 2, iterations: 3 }); // 1,1,0
    });

    it('maxIterationsに達したら打ち切る(1回の実行あたり総文数を1,000未満に抑える安全弁)', async () => {
      const { storage } = ctx;
      const p = await storage.createProject(scope, { name: 'proj-loop-cap' }, BASE_NOW);
      await seedCommittedTestCase(storage, scope, p.id, {
        token: 'tok-a', origin: 'discovery-v1', externalRef: 'ext-a',
        entries: [{ fingerprint: 'fp-a-old', createdAt: OLD_TS }, { fingerprint: 'fp-a-latest', createdAt: OLD_TS + 500 }],
        commitNow: OLD_TS + 1000,
      });
      await seedCommittedTestCase(storage, scope, p.id, {
        token: 'tok-b', origin: 'selfheal-v1', externalRef: 'ext-b',
        entries: [{ fingerprint: 'fp-b-old', createdAt: OLD_TS }, { fingerprint: 'fp-b-latest', createdAt: OLD_TS + 500 }],
        commitNow: OLD_TS + 1000,
      });

      // 2件対象だが maxIterations=1 で打ち切られ、1件しか消えない
      const result = await purgeObservationsUntilDone(storage, { now: BASE_NOW, retentionMs: RETENTION_MS, batchLimit: 1, maxIterations: 1 });
      expect(result).toEqual({ deleted: 1, iterations: 1 });
    });
  });

  describe('purge.ts: purgeSyncWorkdataUntilDone', () => {
    it('0件になるまで繰り返しstorage.purgeSyncWorkdataを呼び、合計削除件数と反復回数を返す', async () => {
      const { storage } = ctx;
      const p = await storage.createProject(scope, { name: 'proj-workdata-loop' }, BASE_NOW);
      const started = await storage.syncStart(scope, p.id, { token: 'tok-wdl', origin: 'discovery-v1', now: BASE_NOW, slidingMs: 365 * DAY_MS });
      if (started.kind !== 'created') throw new Error('unreachable');
      await storage.syncAppendObservations(scope, p.id, started.session, [
        { externalRef: 'ext-wdl', fingerprint: 'fp-wdl', observed: obsPayload(), category: null, confidence: null },
      ], BASE_NOW);
      await commitToConvergence(storage, scope, p.id, 'tok-wdl', { now: BASE_NOW + 1, identityTtlMs: 365 * DAY_MS, windowLimit: 1000, actor: 'token:test' });
      await storage.syncFinalize(scope, p.id, 'tok-wdl', BASE_NOW + 2);

      const result = await purgeSyncWorkdataUntilDone(storage, { maxIterations: 10 });
      expect(result.deleted).toBe(2); // staging 1行 + seen 1行
      expect(result.iterations).toBe(2); // 1回目で2件削除、2回目で0件確認して停止
    });
  });

  // --- Storage.sweepExpiredSyncSessions(sync-protocol.md「失効の執行モデル」セカンダリ) -----------

  describe('Storage.sweepExpiredSyncSessions', () => {
    it('全プロジェクト横断で active かつ期限切れのみ expired に倒す(期限内 active は残す)', async () => {
      const { storage } = ctx;
      const p1 = await storage.createProject(scope, { name: 'proj-sweep-1' }, BASE_NOW);
      const p2 = await storage.createProject(scope, { name: 'proj-sweep-2' }, BASE_NOW);
      const p3 = await storage.createProject(scope, { name: 'proj-sweep-3' }, BASE_NOW);

      await storage.syncStart(scope, p1.id, { token: 'tok-sweep-1', origin: 'discovery-v1', now: BASE_NOW - 10_000, slidingMs: 1000 });
      await storage.syncStart(scope, p2.id, { token: 'tok-sweep-2', origin: 'discovery-v1', now: BASE_NOW - 10_000, slidingMs: 1000 });
      await storage.syncStart(scope, p3.id, { token: 'tok-sweep-3', origin: 'discovery-v1', now: BASE_NOW, slidingMs: 365 * DAY_MS });

      const n = await storage.sweepExpiredSyncSessions(BASE_NOW);
      expect(n).toBe(2); // p1, p2(別プロジェクト2件を横断)

      expect((await storage.syncGetSession(scope, p1.id, 'tok-sweep-1'))?.status).toBe('expired');
      expect((await storage.syncGetSession(scope, p2.id, 'tok-sweep-2'))?.status).toBe('expired');
      expect((await storage.syncGetSession(scope, p3.id, 'tok-sweep-3'))?.status).toBe('active');
    });
  });

  // --- Storage.deleteExpiredUiSessions ------------------------------------------------------

  describe('Storage.deleteExpiredUiSessions', () => {
    it('期限切れUIセッションをlimit件まで削除し、期限内は残す(反復で全件到達)', async () => {
      const { storage } = ctx;
      const admin = (await storage.findUserForLogin('admin@example.com'))!;
      await storage.createSession({ id: 'sess-1', userId: admin.id, expiresAt: BASE_NOW - 1000, createdAt: BASE_NOW - 100_000 });
      await storage.createSession({ id: 'sess-2', userId: admin.id, expiresAt: BASE_NOW - 2000, createdAt: BASE_NOW - 100_000 });
      await storage.createSession({ id: 'sess-3', userId: admin.id, expiresAt: BASE_NOW - 3000, createdAt: BASE_NOW - 100_000 });
      await storage.createSession({ id: 'sess-live', userId: admin.id, expiresAt: BASE_NOW + 100_000, createdAt: BASE_NOW - 100_000 });

      expect(await storage.deleteExpiredUiSessions(BASE_NOW, 2)).toBe(2); // limitを尊重(3件対象だが2件のみ)
      expect(await storage.deleteExpiredUiSessions(BASE_NOW, 2)).toBe(1); // 残り1件
      expect(await storage.deleteExpiredUiSessions(BASE_NOW, 2)).toBe(0);

      expect(await storage.getSession('sess-live')).not.toBeNull();
      expect(await storage.getSession('sess-1')).toBeNull();
      expect(await storage.getSession('sess-2')).toBeNull();
      expect(await storage.getSession('sess-3')).toBeNull();
    });
  });

  describe('sweep.ts: sweepExpired', () => {
    it('sweepExpiredSyncSessionsを1回・deleteExpiredUiSessionsをbatchLimit刻みで収束するまで呼ぶ', async () => {
      const { storage } = ctx;
      const p = await storage.createProject(scope, { name: 'proj-sweep-helper' }, BASE_NOW);
      await storage.syncStart(scope, p.id, { token: 'tok-sh-1', origin: 'discovery-v1', now: BASE_NOW - 10_000, slidingMs: 1000 });

      const admin = (await storage.findUserForLogin('admin@example.com'))!;
      await storage.createSession({ id: 'sess-sh-1', userId: admin.id, expiresAt: BASE_NOW - 1000, createdAt: BASE_NOW - 50_000 });
      await storage.createSession({ id: 'sess-sh-2', userId: admin.id, expiresAt: BASE_NOW - 1000, createdAt: BASE_NOW - 50_000 });
      await storage.createSession({ id: 'sess-sh-3', userId: admin.id, expiresAt: BASE_NOW - 1000, createdAt: BASE_NOW - 50_000 });

      const result = await sweepExpired(storage, { now: BASE_NOW, uiSessionBatchLimit: 1, uiSessionMaxIterations: 10 });
      expect(result).toEqual({ syncSessionsExpired: 1, uiSessionsDeleted: 3, uiSessionIterations: 4 });
    });
  });

  // --- Storage.purgeSyncWorkdata -------------------------------------------------------------

  describe('Storage.purgeSyncWorkdata', () => {
    it('committed/expiredセッションのsync_staging+sync_seenを削除し、activeセッションのものは残す(2セッションの混在)', async () => {
      const { storage, sqlite } = ctx;
      const p = await storage.createProject(scope, { name: 'proj-workdata' }, BASE_NOW);

      // Session A: committed(staging + seen が両方残っているはず)
      const startedA = await storage.syncStart(scope, p.id, { token: 'tok-wd-a', origin: 'discovery-v1', now: BASE_NOW, slidingMs: 365 * DAY_MS });
      if (startedA.kind !== 'created') throw new Error('unreachable');
      await storage.syncAppendObservations(scope, p.id, startedA.session, [
        { externalRef: 'ext-wd-a', fingerprint: 'fp-wd-a', observed: obsPayload(), category: null, confidence: null },
      ], BASE_NOW);
      await commitToConvergence(storage, scope, p.id, 'tok-wd-a', { now: BASE_NOW + 1, identityTtlMs: 365 * DAY_MS, windowLimit: 1000, actor: 'token:test' });
      await storage.syncFinalize(scope, p.id, 'tok-wd-a', BASE_NOW + 2);

      // Session B: active のまま(commitWindow までは進めるが finalize しない → staging/seen があっても保護される)
      const startedB = await storage.syncStart(scope, p.id, { token: 'tok-wd-b', origin: 'selfheal-v1', now: BASE_NOW, slidingMs: 365 * DAY_MS });
      if (startedB.kind !== 'created') throw new Error('unreachable');
      await storage.syncAppendObservations(scope, p.id, startedB.session, [
        { externalRef: 'ext-wd-b', fingerprint: 'fp-wd-b', observed: obsPayload(), category: null, confidence: null },
      ], BASE_NOW);
      await commitToConvergence(storage, scope, p.id, 'tok-wd-b', { now: BASE_NOW + 1, identityTtlMs: 365 * DAY_MS, windowLimit: 1000, actor: 'token:test' });

      // Session C: 後で expired にする(append のみ。staging行は無し・seen行のみ)
      const startedC = await storage.syncStart(scope, p.id, { token: 'tok-wd-c', origin: 'third-origin', now: BASE_NOW, slidingMs: 1000 });
      if (startedC.kind !== 'created') throw new Error('unreachable');
      await storage.syncAppendObservations(scope, p.id, startedC.session, [
        { externalRef: 'ext-wd-c', fingerprint: 'fp-wd-c', observed: obsPayload(), category: null, confidence: null },
      ], BASE_NOW);
      await storage.sweepExpiredSyncSessions(BASE_NOW + 100_000); // BASE_NOW+100_000 > expiresAt(BASE_NOW+1000) → expired
      expect((await storage.syncGetSession(scope, p.id, 'tok-wd-c'))?.status).toBe('expired');

      const countRows = (table: string, token: string): number =>
        (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE sync_token = ?`).get(token) as { n: number }).n;

      // purge前の前提確認
      expect(countRows('sync_staging', 'tok-wd-a')).toBe(1);
      expect(countRows('sync_seen', 'tok-wd-a')).toBe(1);
      expect(countRows('sync_staging', 'tok-wd-b')).toBe(1);
      expect(countRows('sync_seen', 'tok-wd-b')).toBe(1);
      expect(countRows('sync_staging', 'tok-wd-c')).toBe(0); // commitWindowを呼んでいないためstagingは無い
      expect(countRows('sync_seen', 'tok-wd-c')).toBe(1);

      const deleted = await storage.purgeSyncWorkdata();
      // committed(tok-wd-a): staging1+seen1=2 / expired(tok-wd-c): seen1(staging無し) = 合計3
      expect(deleted).toBe(3);

      expect(countRows('sync_staging', 'tok-wd-a')).toBe(0);
      expect(countRows('sync_seen', 'tok-wd-a')).toBe(0);
      expect(countRows('sync_staging', 'tok-wd-b')).toBe(1); // active は残る
      expect(countRows('sync_seen', 'tok-wd-b')).toBe(1);
      expect(countRows('sync_seen', 'tok-wd-c')).toBe(0);
    });
  });

  // --- Storage.countsSnapshot ------------------------------------------------------------------

  describe('Storage.countsSnapshot', () => {
    it('data-model.mdの11エンティティに対応する11キーを返し、実際の行数を反映する(sync_seenは未文書化のため対象外)', async () => {
      const { storage } = ctx;
      const p = await storage.createProject(scope, { name: 'proj-counts' }, BASE_NOW);
      await storage.createTestCaseManual(scope, p.id, tcInput(), historyEntry(), BASE_NOW);
      await storage.createTestCaseManual(scope, p.id, tcInput(), historyEntry(), BASE_NOW);

      const counts = await storage.countsSnapshot();
      expect(Object.keys(counts).sort()).toEqual([
        'api_tokens', 'organizations', 'projects', 'sessions', 'sync_sessions', 'sync_staging',
        'test_case_history', 'test_case_identities', 'test_case_observations', 'test_cases', 'users',
      ].sort());
      expect(counts.organizations).toBe(1);
      expect(counts.projects).toBe(1);
      expect(counts.test_cases).toBe(2);
      expect(counts.test_case_history).toBe(2); // createTestCaseManual の action='created' 履歴
      expect(counts.users).toBe(1); // setupOrganization の admin のみ
    });
  });

  // --- src/maintenance/index.ts: runMaintenance(順序・構造化ログ) ------------------------------

  describe('runMaintenance', () => {
    it(
      '観測パージ→sweep→UIセッション削除→workdataパージ→countsの順に呼び、構造化ログ1行を出力する' +
        '(期限切れだがまだactiveなセッションのworkdataが同一run内で消えることが、sweepがworkdataパージより先に走る証拠)',
      async () => {
        const { storage } = ctx;
        const p = await storage.createProject(scope, { name: 'proj-run' }, BASE_NOW);

        // 91日前のcommitted観測(削除対象)+ 同ペアのsurvivor
        await seedCommittedTestCase(storage, scope, p.id, {
          token: 'tok-run-a', origin: 'discovery-v1', externalRef: 'ext-run-a',
          entries: [{ fingerprint: 'fp-run-old', createdAt: OLD_TS }, { fingerprint: 'fp-run-latest', createdAt: OLD_TS + 500 }],
          commitNow: OLD_TS + 1000,
        });

        // 期限切れだがまだ status='active' のセッション(sweepが最初にexpiredへ倒すはず)。
        // 実運用の「衛星が死んで sliding 失効した」を模す: commitWindowまでは進めるがfinalizeしない。
        const startedExpiring = await storage.syncStart(scope, p.id, {
          token: 'tok-run-expiring', origin: 'selfheal-v1', now: BASE_NOW - 100_000, slidingMs: 1000,
        });
        if (startedExpiring.kind !== 'created') throw new Error('unreachable');
        await storage.syncAppendObservations(scope, p.id, startedExpiring.session, [
          { externalRef: 'ext-run-b', fingerprint: 'fp-run-b', observed: obsPayload(), category: null, confidence: null },
        ], BASE_NOW - 100_000);
        await commitToConvergence(storage, scope, p.id, 'tok-run-expiring', {
          now: BASE_NOW - 100_000 + 1, identityTtlMs: 365 * DAY_MS, windowLimit: 1000, actor: 'token:test',
        });
        // このセッションの expiresAt = (BASE_NOW-100_000)+1000 なので BASE_NOW 時点では期限切れだが
        // status はまだ 'active'(sliding延長を誰も呼んでいないため)。

        const admin = (await storage.findUserForLogin('admin@example.com'))!;
        await storage.createSession({ id: 'sess-run-expired', userId: admin.id, expiresAt: BASE_NOW - 1000, createdAt: BASE_NOW - 200_000 });

        const logs: string[] = [];
        const deps: MaintenanceDeps = {
          storage, now: () => BASE_NOW, retentionMs: RETENTION_MS,
          purgeBatchLimit: 10, purgeMaxIterations: 10,
          uiSessionBatchLimit: 10, uiSessionMaxIterations: 10,
          workdataMaxIterations: 10,
          log: (line) => logs.push(line),
        };

        await runMaintenance(deps);

        expect(logs).toHaveLength(1);
        const parsed = JSON.parse(logs[0]!);
        expect(parsed.event).toBe('maintenance_run');
        expect(parsed.observations_purged).toBe(1); // fp-run-old のみ
        expect(parsed.sync_sessions_expired).toBe(1); // tok-run-expiring
        expect(parsed.ui_sessions_deleted).toBe(1); // sess-run-expired
        // tok-run-a(committed)分2行 + tok-run-expiring(このrun内でsweepにより先にexpired化)分2行 = 4
        expect(parsed.sync_workdata_purged).toBe(4);
        expect(parsed.table_counts.organizations).toBe(1);

        expect((await storage.syncGetSession(scope, p.id, 'tok-run-expiring'))?.status).toBe('expired');
        expect(await storage.getSession('sess-run-expired')).toBeNull();
      },
    );

    it('チューニング引数を省略すると既定値が使われ、logを省略するとconsole.logへJSON1行を出力する', async () => {
      const { storage } = ctx;
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runMaintenance({ storage, now: () => BASE_NOW, retentionMs: RETENTION_MS });
        expect(spy).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
        expect(parsed.event).toBe('maintenance_run');
        expect(parsed.table_counts.organizations).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
