// tests/unit/sync-commit.test.ts
// task-16-brief.md: src/domain/sync-commit.ts(工程の述語の純粋部分)の単体テスト。
// commit 8工程パイプラインは大半が set-based SQL(drizzle-storage.ts)で実行されるが、
// 「観測 category のフォールバック(工程1)」「mappings の3分類(syncMappings)」
// 「rollup の is_stale 集約述語(工程7。TTL 判定含む)」は DB を伴わない純粋なロジックとして
// 切り出せるため、GC-6(domain は D1/workers-types を import しない)に従い純関数化し、
// ここで単体に検証する。工程7の実際の書き込みは drizzle-storage.ts の相関サブクエリ SQL が担うが、
// この純関数は「同じ述語」の実行可能な仕様として、SQL 側の意図を裏付けるために存在する
// (drizzle-storage.ts のコメントから本ファイルの関数名を相互参照する)。
import { describe, it, expect } from 'vitest';
import {
  resolveCanonicalCategory,
  classifySyncMappings,
  isIdentityLive,
  computeCanonicalIsStale,
} from '../../src/domain/sync-commit';
import { createBetterSqlite3Storage } from '../../src/storage/adapters/better-sqlite3';
import type { Storage, OrgScope } from '../../src/storage/interface';

describe('domain/sync-commit: resolveCanonicalCategory(工程1のcategoryフォールバック)', () => {
  it('観測に category があればそれを採用する', () => {
    expect(resolveCanonicalCategory('boundary')).toBe('boundary');
  });
  it('観測に category が無ければ normal にフォールバックする', () => {
    expect(resolveCanonicalCategory(null)).toBe('normal');
  });
});

describe('domain/sync-commit: classifySyncMappings(syncMappings の3分類)', () => {
  it('staging に有る ref は created', () => {
    const result = classifySyncMappings({
      stagingRefs: ['ext-new'],
      observedRefs: [],
      seenRefs: ['ext-new'],
    });
    expect(result).toEqual([{ externalRef: 'ext-new', outcome: 'created' }]);
  });

  it('staging に無く観測(:T)が有る ref は updated', () => {
    const result = classifySyncMappings({
      stagingRefs: [],
      observedRefs: ['ext-changed'],
      seenRefs: ['ext-changed'],
    });
    expect(result).toEqual([{ externalRef: 'ext-changed', outcome: 'updated' }]);
  });

  it('sync_seen のみ(staging にも観測にも無い)の ref は unchanged', () => {
    const result = classifySyncMappings({
      stagingRefs: [],
      observedRefs: [],
      seenRefs: ['ext-unchanged'],
    });
    expect(result).toEqual([{ externalRef: 'ext-unchanged', outcome: 'unchanged' }]);
  });

  it('3種混在・staged が最優先(staging かつ観測に同時に載っていても created)', () => {
    const result = classifySyncMappings({
      stagingRefs: ['ext-a', 'ext-priority'],
      observedRefs: ['ext-b', 'ext-priority'],
      seenRefs: ['ext-a', 'ext-b', 'ext-c', 'ext-priority'],
    });
    const byRef = new Map(result.map((r) => [r.externalRef, r.outcome]));
    expect(byRef.get('ext-a')).toBe('created');
    expect(byRef.get('ext-b')).toBe('updated');
    expect(byRef.get('ext-c')).toBe('unchanged');
    expect(byRef.get('ext-priority')).toBe('created'); // staging が最優先
    expect(result).toHaveLength(4);
  });

  it('seenRefs の重複は1件として畳み込まれる', () => {
    const result = classifySyncMappings({ stagingRefs: [], observedRefs: [], seenRefs: ['ext-x', 'ext-x'] });
    expect(result).toEqual([{ externalRef: 'ext-x', outcome: 'unchanged' }]);
  });
});

describe('domain/sync-commit: isIdentityLive(rollup の TTL 判定)', () => {
  const now = 1_700_000_000_000;
  const ttl = 90 * 24 * 60 * 60 * 1000;

  it('last_seen_at が null なら live ではない', () => {
    expect(isIdentityLive(null, now, ttl)) .toBe(false);
  });
  it('TTL 内なら live', () => {
    expect(isIdentityLive(now - 1000, now, ttl)).toBe(true);
  });
  it('TTL ちょうど(境界)は live ではない(> の厳密比較)', () => {
    expect(isIdentityLive(now - ttl, now, ttl)).toBe(false);
  });
  it('TTL 超過は live ではない(凍結)', () => {
    expect(isIdentityLive(now - ttl - 1, now, ttl)).toBe(false);
  });
});

describe('domain/sync-commit: computeCanonicalIsStale(工程7 rollup の集約述語)', () => {
  const now = 1_700_000_000_000;
  const ttl = 90 * 24 * 60 * 60 * 1000;

  it('identity が1件も無ければ stale ではない(EXISTS(live)が偽)', () => {
    expect(computeCanonicalIsStale([], now, ttl)).toBe(false);
  });

  it('live な identity が全て stale なら canonical も stale', () => {
    const identities = [
      { isStale: true, lastSeenAt: now - 1000 },
      { isStale: true, lastSeenAt: now - 2000 },
    ];
    expect(computeCanonicalIsStale(identities, now, ttl)).toBe(true);
  });

  it('live な identity が1つでも non-stale なら canonical は stale ではない', () => {
    const identities = [
      { isStale: true, lastSeenAt: now - 1000 },
      { isStale: false, lastSeenAt: now - 2000 },
    ];
    expect(computeCanonicalIsStale(identities, now, ttl)).toBe(false);
  });

  it('TTL 超過(凍結)の identity のみの場合は集約から除外され stale にならない(引退オリジンの永久ブロッカー防止)', () => {
    const identities = [{ isStale: true, lastSeenAt: now - ttl - 1 }];
    expect(computeCanonicalIsStale(identities, now, ttl)).toBe(false);
  });

  it('live(非stale)+凍結(stale) の混在は、凍結側を無視して live 側のみで判定する(non-stale なので false)', () => {
    const identities = [
      { isStale: false, lastSeenAt: now - 1000 }, // live, not stale
      { isStale: true, lastSeenAt: now - ttl - 1 }, // frozen, excluded
    ];
    expect(computeCanonicalIsStale(identities, now, ttl)).toBe(false);
  });

  it('live(stale)+凍結(non-stale) の混在は、凍結側を無視して live 側のみで判定する(全live がstaleなので true)', () => {
    const identities = [
      { isStale: true, lastSeenAt: now - 1000 }, // live, stale
      { isStale: false, lastSeenAt: now - ttl - 1 }, // frozen, excluded
    ];
    expect(computeCanonicalIsStale(identities, now, ttl)).toBe(true);
  });
});

// --- drizzle-storage.ts: syncCommitWindow 工程6(drift 記録)の収束性 ---------------------------------
// FINAL whole-branch review Finding 1(CRITICAL): 工程6の内側 WHERE(rowid サブクエリ)は
// `ownership='human' AND fingerprint != <最新committed fingerprint>` のみで、工程3/4/7 と違って
// 「既に drift=1 の行を除外する」自己排他述語(例: `AND drift = 0`)を欠いていた。SQLite の UPDATE は
// 値が変わらない書き込みでも changes() を1件としてカウントするため、一度 drift=1 になった行は二度と
// 述語から抜けず(accept-fingerprint が唯一の出口)、
//   (a) windowLimit 超の drift 対象が1つの origin に存在すると、工程6の count が毎回 windowLimit と
//       一致し続け、`more`(`windowedCounts.some(c => c >= windowLimit)`)が永遠に false にならない
//       (windowed-resume livelock。commit が 202 を返し続け、その origin の同期が永久に完了しない)、
//   (b) 変化の無い再同期でも drift 済み行の system_updated_at が commit のたびに bump される
//       (D-05 の updated_at 意味論違反。実際の変化が無いのに updated_at だけ動き続ける)、
// という2つの不具合を招く。better-sqlite3 直結の Storage(tests/unit/maintenance.test.ts と同じ流儀)で
// 高速に再現する。fix: 内側 WHERE に `AND drift = 0` を追加し、工程3/4/7 と同じ自己排他述語のスタイルに
// 揃える(docs/sync-protocol.md「`drift = 1` の再設定は冪等」を「既に drift 済みの行は再度触らない」の
// 意味で満たす)。
describe('drizzle-storage: syncCommitWindow 工程6(drift 記録)の収束性 — Finding 1(CRITICAL)regression', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const YEAR_MS = 365 * DAY_MS;
  const BASE_NOW = 1_700_000_000_000;
  const origin = 'discovery-v1';
  const N = 5; // SMALL_WINDOW を超える drift 対象行数
  const SMALL_WINDOW = 2;
  const HARD_CAP = 10; // brief: 「ハード反復キャップ(例: 10)」

  function obsPayload() {
    return { title: 't', given: 'g', when: 'w', then: 'th', parameters: [], source_ref: {}, schema_version: '1.0' };
  }

  /**
   * N件の external_ref を1本の sync セッションで start→append→commit収束(大きめの windowLimit。
   * 工程0〜2は windowLimit の対象外なので値自体は本質的でない)→finalize まで進め、
   * external_ref → test_case_id の Map を返す(round1: machine-owned baseline 行を作る専用ヘルパ)。
   */
  async function seedBaselineMachineRows(
    storage: Storage, scope: OrgScope, pid: string,
    opts: { token: string; refs: string[]; fingerprintOf: (ref: string) => string; now: number },
  ): Promise<Map<string, string>> {
    const started = await storage.syncStart(scope, pid, { token: opts.token, origin, now: opts.now, slidingMs: YEAR_MS });
    if (started.kind !== 'created') throw new Error('seedBaselineMachineRows: syncStart conflict');
    await storage.syncAppendObservations(scope, pid, started.session, opts.refs.map((ref) => ({
      externalRef: ref, fingerprint: opts.fingerprintOf(ref), observed: obsPayload(), category: null, confidence: null,
    })), opts.now);

    let more = true;
    for (let i = 1; more; i++) {
      if (i > 50) throw new Error('seedBaselineMachineRows: commit did not converge within 50 iterations');
      const r = await storage.syncCommitWindow(scope, pid, opts.token, {
        now: opts.now + i, identityTtlMs: YEAR_MS, windowLimit: 1000, actor: 'token:test-actor',
      });
      more = r.more;
    }
    await storage.syncFinalize(scope, pid, opts.token, opts.now + 1000);

    const mappings = await storage.syncMappings(scope, pid, opts.token);
    const idByRef = new Map<string, string>();
    for (const ref of opts.refs) {
      const m = mappings.find((x) => x.externalRef === ref);
      if (!m) throw new Error(`seedBaselineMachineRows: mapping not found for ${ref}`);
      idByRef.set(ref, m.testCaseId);
    }
    return idByRef;
  }

  /**
   * 共通セットアップ: N件の machine-owned canonical を作り、全行を human 化(直接 SQL — PATCH の
   * ドメインロジックを経由せず、工程6の前提状態「human所有・fingerprint凍結・mirror_origin設定済み」
   * だけを最短で作る。tests/integration/sync-commit.test.ts シナリオ10が is_stale/last_seen_at を
   * 直接 seed するのと同じ流儀)した上で、同じ external_ref に新しい fingerprint を送る第2セッションを
   * start+append まで進めておく(commit の実行と収束の検証はテストごとに行う)。
   */
  async function setupDriftEligibleRows() {
    const { storage, sqlite } = createBetterSqlite3Storage(':memory:');
    const r = await storage.setupOrganization({
      orgName: 'org', adminEmail: 'admin@example.com', adminPasswordHash: '$pbkdf2-sha256$i=1$x$y',
      adminDisplayName: 'Admin', now: BASE_NOW,
    });
    const scope: OrgScope = { organizationId: r.organization.id };
    const p = await storage.createProject(scope, { name: 'proj-drift-converge' }, BASE_NOW);
    const refs = Array.from({ length: N }, (_, i) => `ext-drift-${i}`);

    const idByRef = await seedBaselineMachineRows(storage, scope, p.id, {
      token: 'tok-baseline', refs, fingerprintOf: (ref) => `fp-v1-${ref}`, now: BASE_NOW,
    });
    const ids = refs.map((ref) => idByRef.get(ref)!);

    // 全行を human 化(直接 SQL)。status は 'draft' のまま(ck_tc_status_ownership を無条件に満たす)。
    const placeholders = ids.map(() => '?').join(',');
    sqlite.prepare(`UPDATE test_cases SET ownership='human' WHERE id IN (${placeholders})`).run(...ids);
    const preconditionRows = sqlite.prepare(
      `SELECT ownership, drift FROM test_cases WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<{ ownership: string; drift: number }>;
    if (!preconditionRows.every((row) => row.ownership === 'human' && row.drift === 0)) {
      throw new Error('setupDriftEligibleRows: precondition violated (not all rows human-owned + drift=0)');
    }

    // 第2セッション: 同一 external_ref に新しい fingerprint(工程6のdrift対象化)。
    const now2 = BASE_NOW + 10_000;
    const s2 = await storage.syncStart(scope, p.id, { token: 'tok-drift', origin, now: now2, slidingMs: YEAR_MS });
    if (s2.kind !== 'created') throw new Error('unreachable');
    await storage.syncAppendObservations(scope, p.id, s2.session, refs.map((ref) => ({
      externalRef: ref, fingerprint: `fp-v2-${ref}`, observed: obsPayload(), category: null, confidence: null,
    })), now2);

    return { storage, sqlite, scope, pid: p.id, ids, refs, now2 };
  }

  it(
    `windowLimit(${SMALL_WINDOW}) 超の drift 対象(${N}行)があっても commit は ${HARD_CAP} 回以内に収束する` +
      '(pre-fix: 工程6が drift=1 済み行を除外せず毎回 count==windowLimit を出し続け more が false にならない' +
      ' = windowed-resume livelock。post-fix: `AND drift=0` により収束する)',
    async () => {
      const { storage, sqlite, scope, pid, ids, now2 } = await setupDriftEligibleRows();

      let more = true;
      for (let i = 1; i <= HARD_CAP && more; i++) {
        const res = await storage.syncCommitWindow(scope, pid, 'tok-drift', {
          now: now2 + i, identityTtlMs: YEAR_MS, windowLimit: SMALL_WINDOW, actor: 'token:test-actor',
        });
        more = res.more;
      }

      // pre-fix: ここで more は true のまま(livelock) → 失敗。post-fix: 収束して false → 成功。
      expect(more).toBe(false);

      // 収束したなら実際に全行へ drift=1 が反映されているはず(no-opで「進んだふり」をしていないことの証拠)。
      const placeholders = ids.map(() => '?').join(',');
      const rows = sqlite.prepare(`SELECT drift FROM test_cases WHERE id IN (${placeholders})`).all(...ids) as Array<{ drift: number }>;
      expect(rows.filter((row) => row.drift === 1)).toHaveLength(N);
    },
  );

  it(
    '変化の無い(同一fingerprintの)再同期は、既に drift=1 の行の system_updated_at を churn させない' +
      '(pre-fix: 工程6が毎回 same-value UPDATE を打ち直し system_updated_at を bump し続ける = D-05 違反。' +
      'post-fix: `AND drift=0` により既に drift=1 の行は触られない)',
    async () => {
      // このテストは churn の有無だけを見るため、windowLimit は N を上回る値にしてtest1の収束性livelockを
      // 変数から排除する(1回のcommitで確実に全行へ drift=1 が反映される前提を作れる大きな窓を使う)。
      const LARGE_WINDOW = 1000;
      const { storage, sqlite, scope, pid, ids, refs, now2 } = await setupDriftEligibleRows();

      let more = true;
      for (let i = 1; more; i++) {
        if (i > 10) throw new Error('round2 commit did not converge within 10 iterations (LARGE_WINDOW > N のため想定外)');
        const res = await storage.syncCommitWindow(scope, pid, 'tok-drift', {
          now: now2 + i, identityTtlMs: YEAR_MS, windowLimit: LARGE_WINDOW, actor: 'token:test-actor',
        });
        more = res.more;
      }
      await storage.syncFinalize(scope, pid, 'tok-drift', now2 + 1000);

      const placeholders = ids.map(() => '?').join(',');
      const after2 = sqlite.prepare(
        `SELECT id, drift, system_updated_at AS systemUpdatedAt FROM test_cases WHERE id IN (${placeholders})`,
      ).all(...ids) as Array<{ id: string; drift: number; systemUpdatedAt: number }>;
      expect(after2.every((row) => row.drift === 1)).toBe(true); // 前提: 全行がdrift済み
      const snapshot = new Map(after2.map((row) => [row.id, row.systemUpdatedAt]));

      // round3: 「衛星が全く同じ fingerprint で再同期した」を模す(実質的な変化なし)。
      const now3 = now2 + 100_000;
      const s3 = await storage.syncStart(scope, pid, { token: 'tok-nochange', origin, now: now3, slidingMs: YEAR_MS });
      if (s3.kind !== 'created') throw new Error('unreachable');
      await storage.syncAppendObservations(scope, pid, s3.session, refs.map((ref) => ({
        externalRef: ref, fingerprint: `fp-v2-${ref}`, observed: obsPayload(), category: null, confidence: null, // round2 と同一 fingerprint
      })), now3);
      await storage.syncCommitWindow(scope, pid, 'tok-nochange', {
        now: now3 + 1, identityTtlMs: YEAR_MS, windowLimit: LARGE_WINDOW, actor: 'token:test-actor',
      });

      const after3 = sqlite.prepare(
        `SELECT id, system_updated_at AS systemUpdatedAt FROM test_cases WHERE id IN (${placeholders})`,
      ).all(...ids) as Array<{ id: string; systemUpdatedAt: number }>;
      for (const row of after3) {
        // pre-fix: round3 の commit(now3+1)へ bump されて失敗。post-fix: round2 時点のまま不変で成功。
        expect(row.systemUpdatedAt).toBe(snapshot.get(row.id));
      }
    },
  );
});
